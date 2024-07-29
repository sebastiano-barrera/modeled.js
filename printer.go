package modeledjs

import (
	"fmt"
	"io"
	"reflect"
	"strings"

	"github.com/robertkrimen/otto/ast"
	parserFile "github.com/robertkrimen/otto/file"
	"github.com/robertkrimen/otto/parser"
)

func PrintAST(rdr io.Reader) (err error) {
	program, err := parser.ParseFile(nil, "<>", rdr, 0)

	walker := &printer{
		file: program.File,
	}
	ast.Walk(walker, program)

	return
}

type printer struct {
	file   *parserFile.File
	indent int
}

func (p *printer) Enter(n ast.Node) (v ast.Visitor) {
	for i := 0; i < p.indent; i++ {
		fmt.Print("|   ")
	}
	t := reflect.TypeOf(n)

	start := n.Idx0() - parserFile.Idx(p.file.Base())
	end := n.Idx1() - parserFile.Idx(p.file.Base())
	subSrc := p.file.Source()[start:end]
	if strings.Contains(subSrc, "\n") {
		subSrc = ""
	}

	if pos := p.file.Position(n.Idx0()); pos != nil {
		fmt.Printf("%s:  %s  %s\n", t.String(), pos, subSrc)
	} else {
		fmt.Printf("%s:  %s  %s\n", t.String(), pos, subSrc)
	}

	p.indent++
	return p
}

func (p *printer) Exit(n ast.Node) {
	p.indent--
}
