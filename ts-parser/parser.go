package tsparser

import (
	"context"
	"fmt"
	"io"

	// "log"

	ts "github.com/smacker/go-tree-sitter"
	javascript "github.com/smacker/go-tree-sitter/javascript"
)

func ParseReader(path string, rdr io.Reader) (err error) {
	bytes, err := io.ReadAll(rdr)
	if err == nil {
		err = ParseBytes(path, bytes)
	}
	return
}

func ParseBytes(path string, bytes []byte) (err error) {
	parser := ts.NewParser()
	parser.SetLanguage(javascript.GetLanguage())

	ctx := context.TODO()
	tree, err := parser.ParseCtx(ctx, nil, bytes)
	if err != nil {
		return
	}

	iter := ts.NewIterator(tree.RootNode(), ts.DFSMode)
	err = iter.ForEach(func(node *ts.Node) error {
		if node.IsError() {
			return fmt.Errorf("syntax error: %s", node.String())
		}
		return nil
	})

	if err == io.EOF {
		err = nil
	}
	return
}
