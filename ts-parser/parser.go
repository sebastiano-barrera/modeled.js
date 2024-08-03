package tsparser

import (
	"context"
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
	_, err = parser.ParseCtx(ctx, nil, bytes)
	return
}
