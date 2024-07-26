package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path"

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
	}

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
		err = fmt.Errorf("while parsing metadata: %w", err)
	}
	log.Printf("metadata = %#v", mt)

	runInMode := func(forceStrict bool) (err error) {
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
		return vm.RunScriptFile(testCase, effectiveText)
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

	endNdx := bytes.Index(text[startNdx:], []byte("---*/"))
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
