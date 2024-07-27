package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path"
	"strings"

	// "com.github.sebastianobarrera.modeledjs/modeledjs"

	"com.github.sebastianobarrera.modeledjs/modeledjs"
	yaml "gopkg.in/yaml.v3"
)

var (
	test262Root = flag.String("test262", "", "Path to the test262 respository")
	testCase    = flag.String("single", "", "Run this specific testcase (path relative to the test262 root)")

	textSta    string
	textAssert string

	ErrCaseDisabledInMetadata = errors.New("testcase disabled in metadata")
)

func main() {
	flag.Parse()

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

		fmt.Printf("%d SUCCESSES:\n", successesCount)
		for _, co := range successes {
			strictMode := "sloppy"
			if co.StrictMode {
				strictMode = "strict"
			}
			fmt.Printf("  - %s (%s)\n", co.Path, strictMode)
		}

		fmt.Printf("\n%d FAILURES:\n", failuresCount)
		for _, co := range failures {
			strictMode := "sloppy"
			if co.StrictMode {
				strictMode = "strict"
			}

			fmt.Printf("\t- %s (%s)\n", co.Path, strictMode)

			var errLines []string
			if co.Error != nil {
				errLines = strings.Split(co.Error.Error(), "\n")
			}
			for ndx, line := range errLines {
				if ndx == 0 {
					fmt.Printf("\t|\tERROR: %s\n", line)
				} else {
					fmt.Printf("\t|\t%s\n", line)
				}
			}
		}

		fmt.Printf("\n\n total: %d; %d successes; %d failures", len(result.Cases), successesCount, failuresCount)

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

	for _, relPath := range testCases {
		errStrict, errSloppy := runTestCase(test262Root, relPath)

		result.Cases = append(result.Cases, CaseOutcome{
			Path:       relPath,
			StrictMode: true,
			Success:    (errStrict == nil),
			Error:      errStrict,
		})
		result.Cases = append(result.Cases, CaseOutcome{
			Path:       relPath,
			StrictMode: false,
			Success:    (errSloppy == nil),
			Error:      errSloppy,
		})
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

	text := string(textBytes)

	mt, err := parseMetadata(textBytes)
	if err != nil {
		errStrict = fmt.Errorf("while parsing metadata: %w", err)
		errSloppy = errStrict
		return
	}

	runInMode := func(forceStrict bool) (err error) {
		log.Printf("running %s (strict: %v)", testCase, forceStrict)

		vm := modeledjs.NewVM()

		includes := make([]string, 2+len(mt.Includes))
		includes[0] = path.Join(test262Root, "harness/sta.js")
		includes[1] = path.Join(test262Root, "harness/assert.js")
		for i, incPath := range mt.Includes {
			includes[i+2] = incPath
		}

		for _, path := range includes {
			err = vm.RunScriptFile(path, string(text))
			if err != nil {
				return fmt.Errorf("while running included script %s: %w", path, err)
			}
		}

		effectiveText := text
		if forceStrict {
			effectiveText = "\"use strict\";" + text
		}
		rdr := bytes.NewReader([]byte(effectiveText))
		return vm.RunScriptReader(testCaseAbs, rdr)
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
	OnlyStrict bool
	NoStrict   bool
	Includes   []string
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
		flags    []string
		includes []string
	}

	err = yaml.Unmarshal(metadataYaml, &metadataRaw)
	if err != nil {
		return
	}

	for _, flag := range metadataRaw.flags {
		switch flag {
		case "noStrict":
			mt.NoStrict = true
		case "onlyStrict":
			mt.OnlyStrict = true
		}
	}

	mt.Includes = metadataRaw.includes
	return
}
