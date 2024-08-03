package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"strings"

	"runtime/pprof"

	// "com.github.sebastianobarrera.modeledjs/modeledjs"

	"com.github.sebastianobarrera.modeledjs/modeledjs"
	tsparser "com.github.sebastianobarrera.modeledjs/modeledjs/ts-parser"
	yaml "gopkg.in/yaml.v3"
)

var (
	test262Root = flag.String("test262", "", "Path to the test262 respository")
	testCase    = flag.String("single", "", "Run this specific testcase (path relative to the test262 root)")
	showAST     = flag.Bool("showAST", false, "Show the AST of the main script")
	parseOnly   = flag.Bool("parseOnly", false, "Stop at parsing; test is successful if it parses as expected")
	cpuProfile  = flag.String("cpuProfile", "", "Write CPU profile to this file")

	textSta    string
	textAssert string

	ErrCaseDisabledInMetadata = errors.New("testcase disabled in metadata")
)

func main() {
	flag.Parse()

	if *cpuProfile != "" {
		cpuf, err := os.Create(*cpuProfile)
		if err != nil {
			log.Fatalf("can't create cpu profile file: %s: %s", *cpuProfile, err)
		}
		pprof.StartCPUProfile(cpuf)
		defer pprof.StopCPUProfile()
	}

	if *test262Root == "" {
		log.Fatalf("command line argument is required: -test262 (see -help)")
		os.Exit(1)
	}

	var raw []byte
	raw, err := os.ReadFile(path.Join(*test262Root, "harness/sta.js"))
	if err != nil {
		log.Fatalf("while reading preamble (harness/sta.js): %s", err)
	}
	textSta = string(raw)
	raw, err = os.ReadFile(path.Join(*test262Root, "harness/assert.js"))
	if err != nil {
		log.Fatalf("while reading preamble (harness/assert.js): %s", err)
	}
	textAssert = string(raw)

	if *testCase != "" {
		log.Println("running single test case:", *testCase)
		errStrict, errSloppy := runTestCase(*test262Root, *testCase)
		log.Println("strict:", errStrict)
		log.Println("sloppy:", errSloppy)
	} else {
		testConfig, err := readTestConfig("testConfig.json")
		if err != nil {
			log.Fatalf("while parsing testConfig.json: %s", err)
		}

		result := runMany(*test262Root, testConfig.TestCases)

		successesCount := 0
		failuresCount := 0
		for _, co := range result.Cases {
			if co.Success {
				successesCount++
			} else {
				failuresCount++
			}
		}

		successes := make([]CaseOutcome, 0, successesCount)
		failures := make([]CaseOutcome, 0, failuresCount)
		for _, co := range result.Cases {
			if co.Success {
				successes = append(successes, co)
			} else {
				failures = append(failures, co)
			}
		}

		fmt.Printf("group SUCCESSES %d\n", successesCount)
		for _, co := range successes {
			strictMode := "sloppy"
			if co.StrictMode {
				strictMode = "strict"
			}
			fmt.Printf("case\t%s\t%s\n", co.Path, strictMode)
		}

		fmt.Printf("group FAILURES %d\n", failuresCount)
		for _, co := range failures {
			strictMode := "sloppy"
			if co.StrictMode {
				strictMode = "strict"
			}

			fmt.Printf("case\t%s\t%s\n", co.Path, strictMode)

			var errLines []string
			if co.Error != nil {
				errLines = strings.Split(co.Error.Error(), "\n")
			}
			for ndx, line := range errLines {
				if ndx == 0 {
					fmt.Printf("error\t\t%s\n", line)
				} else {
					fmt.Printf("ectx\t\t%s\n", line)
				}
			}
		}

		fmt.Printf("summary\ttotal: %d; %d successes; %d failures\n", len(result.Cases), successesCount, failuresCount)

	}
}

type TestConfig struct {
	TestCases []string `json:"testCases"`
}

func readTestConfig(filename string) (cfg TestConfig, err error) {
	buf, err := os.ReadFile(filename)
	if err != nil {
		return
	}

	err = json.Unmarshal(buf, &cfg)
	return
}

type RunManyResult struct {
	Cases []CaseOutcome
}

type CaseOutcome struct {
	Path       string
	StrictMode bool

	Success bool
	Error   error
}

func runMany(test262Root string, testCases []string) (result RunManyResult) {
	result.Cases = make([]CaseOutcome, 0, len(testCases)*2)

	sink := make(chan CaseOutcome)

	for _, relPath := range testCases {
		go func() {
			errStrict, errSloppy := runTestCase(test262Root, relPath)

			sink <- CaseOutcome{
				Path:       relPath,
				StrictMode: true,
				Success:    (errStrict == nil || errStrict == ErrCaseDisabledInMetadata),
				Error:      errStrict,
			}
			sink <- CaseOutcome{
				Path:       relPath,
				StrictMode: false,
				Success:    (errSloppy == nil || errSloppy == ErrCaseDisabledInMetadata),
				Error:      errSloppy,
			}
		}()
	}

	for i := 0; i < len(testCases); i++ {
		co := <-sink
		result.Cases = append(result.Cases, co)
	}
	return
}

func runTestCase(test262Root, testCase string) (errStrict, errSloppy error) {
	testCaseAbs := testCase
	if !path.IsAbs(testCase) {
		testCaseAbs = path.Join(test262Root, testCase)
	}

	textBytes, err := os.ReadFile(testCaseAbs)
	if err != nil {
		log.Fatalf("reading testcase %s: %v", testCaseAbs, err)
	}

	if *showAST {
		err := modeledjs.PrintAST(bytes.NewReader(textBytes))

		if err != nil {
			log.Fatalf("parsing and printing AST: %v", err)
		}
	}

	mt, err := parseMetadata(textBytes)
	if err != nil {
		errStrict = fmt.Errorf("while parsing metadata: %w", err)
		errSloppy = errStrict
		return
	}

	runInMode := func(forceStrict bool) (err error) {
		log.Printf("running %s (strict: %v)", testCase, forceStrict)

		vm := modeledjs.NewVM()

		paths := []string{
			path.Join(test262Root, "harness/sta.js"),
			path.Join(test262Root, "harness/assert.js"),
		}
		paths = append(paths, mt.Includes...)
		paths = append(paths, testCaseAbs)

		for i, path := range paths {
			var buf *bytes.Buffer

			if i == len(paths)-1 {
				buf = bytes.NewBufferString("\"use strict\";")
				io.Copy(buf, bytes.NewReader(textBytes))
			} else {
				buf = new(bytes.Buffer)

				f, err := os.Open(path)
				if err != nil {
					return err
				}
				defer f.Close()

				_, err = io.Copy(buf, f)
				if err != nil {
					return err
				}
			}

			if *parseOnly {
				err = tsparser.ParseBytes(path, buf.Bytes())
			} else {
				err = vm.RunScriptReader(path, buf)
			}

			if mt.NegativePhase != "" {
				if err == nil {
					err = fmt.Errorf("expected %s error in phase %s, but none were raised", mt.NegativeType, mt.NegativePhase)
				} else {
					err = nil
				}
			}

			if err != nil {
				return err
			}
		}

		return nil
	}

	if mt.NoStrict {
		errStrict = ErrCaseDisabledInMetadata
	} else {
		errStrict = runInMode(true)
	}
	if mt.OnlyStrict {
		errSloppy = ErrCaseDisabledInMetadata
	} else {
		errSloppy = runInMode(false)
	}

	return
}

type Metadata struct {
	OnlyStrict    bool
	NoStrict      bool
	Includes      []string
	NegativePhase string
	NegativeType  string
}

func parseMetadata(text []byte) (mt Metadata, err error) {
	startNdx := bytes.Index(text, []byte("/*---"))
	if startNdx == -1 {
		return
	}

	endNdx := startNdx + bytes.Index(text[startNdx:], []byte("---*/"))
	if endNdx == -1 {
		err = fmt.Errorf("invalid source code: unterminated metadata comment (started with /*--- at offset %d)", startNdx)
		return
	}

	metadataYaml := text[startNdx+5 : endNdx]

	var metadataRaw struct {
		Flags    []string
		Includes []string
		Negative *struct {
			Phase string
			Type  string
		}
	}

	err = yaml.Unmarshal(metadataYaml, &metadataRaw)
	if err != nil {
		return
	}

	for _, flag := range metadataRaw.Flags {
		switch flag {
		case "noStrict":
			mt.NoStrict = true
		case "onlyStrict":
			mt.OnlyStrict = true
		}
	}

	mt.Includes = metadataRaw.Includes
	if metadataRaw.Negative != nil {
		mt.NegativePhase = metadataRaw.Negative.Phase
		mt.NegativeType = metadataRaw.Negative.Type
	}

	return
}
