package modeledjs

import (
	"fmt"
	"os"
	"reflect"

	"github.com/robertkrimen/otto/ast"
	parserFile "github.com/robertkrimen/otto/file"
	"github.com/robertkrimen/otto/parser"
	"github.com/robertkrimen/otto/token"
)

// overview of the plan:
//
//  - impl 1: as a naive ast interpreter, validated against test262
//      - vm state includes stack and heap
//      - stack identifies variable by names
//  - impl 2: bytecode interpreter, with coarse instructions

type JSValue interface {
	Category() JSVCategory
}

type JSVCategory uint8

const (
	VUndefined JSVCategory = iota
	VNull
	VNumber
	VBoolean
	VString
	VObject
	VBigInt
	VFunction
)

type JSUndefined struct{}

func (v JSUndefined) Category() JSVCategory { return VUndefined }

type JSNull struct{}

func (v JSNull) Category() JSVCategory { return VNull }

type JSNumber float64

func (v JSNumber) Category() JSVCategory { return VNumber }

type JSBoolean bool

func (v JSBoolean) Category() JSVCategory { return VBoolean }

type JSString string

func (v JSString) Category() JSVCategory { return VString }

type Name struct {
	string
	isSymbol bool
}

func (n Name) String() string {
	prefix := ""
	if n.isSymbol {
		prefix = "@@"
	}
	return fmt.Sprintf("%s%s", prefix, n.string)
}

func NameStr(s string) Name {
	return Name{isSymbol: false, string: s}
}

type JSObject struct {
	Prototype   *JSObject
	descriptors map[Name]Descriptor

	// at any given time, only one of these is supposed to be set
	// replace all these with a single interface pointer and type assertions
	arrayPart   []JSValue
	funcPart    *FunctionPart
	primBigInt  JSBigInt
	primNumber  JSNumber
	primBoolean JSBoolean
	primString  JSString
}

type FunctionPart struct {
	isStrict bool
	native   NativeCallback
	params   []string
	body     ast.Statement
}
type NativeCallback func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error)
type CallFlags struct {
	isNew bool
}
type Descriptor struct {
	get, set     *JSObject
	value        JSValue
	configurable bool
	enumerable   bool
	writable     bool
}

func (v *JSObject) Category() JSVCategory {
	if v.funcPart == nil {
		return VObject
	} else {
		return VFunction
	}
}

func NewJSObject(proto *JSObject) JSObject {
	return JSObject{
		Prototype:   proto,
		descriptors: make(map[Name]Descriptor),
	}
}

func (this *JSObject) resolveDescriptor(descriptor *Descriptor, vm *VM) (retVal JSValue, err error) {
	if descriptor.get == nil {
		retVal = descriptor.value
		return
	}
	if vm == nil {
		panic("bug: looking up described value but vm not passed")
	}
	return descriptor.get.Invoke(vm, this, []JSValue{}, CallFlags{})
}
func (this *JSObject) getOwnPropertyDescriptor(name Name) (Descriptor, bool) {
	// TODO Return a pointer?
	d, ok := this.descriptors[name]
	return d, ok
}
func (this *JSObject) getOwnPropertyNames(action func(name Name)) {
	for name := range this.descriptors {
		action(name)
	}
}
func (this *JSObject) GetOwnProperty(name Name, vm *VM) (JSValue, error) {
	descriptor, isThere := this.descriptors[name]
	if !isThere {
		return JSUndefined{}, nil
	}
	return this.resolveDescriptor(&descriptor, vm)
}
func (this *JSObject) HasOwnProperty(name Name) bool {
	_, isThere := this.descriptors[name]
	return isThere
}
func (this *JSObject) GetProperty(name Name, vm *VM) (JSValue, error) {
	object := this
	for {
		if object == nil {
			return JSUndefined{}, nil
		}
		descriptor, isThere := object.getOwnPropertyDescriptor(name)
		if isThere {
			return this.resolveDescriptor(&descriptor, vm)
		}
		object = object.Prototype
	}

}
func (this *JSObject) SetProperty(name Name, value JSValue, vm *VM) error {
	var descriptor Descriptor
	isThere := false

	for object := this; object != nil; object = object.Prototype {
		descriptor, isThere = object.getOwnPropertyDescriptor(name)
		if isThere {
			break
		}
	}

	// TODO Honor writable, configurable, etc.
	if !isThere {
		descriptor = Descriptor{
			value:        value,
			configurable: false,
			enumerable:   false,
			writable:     false,
		}
	} else if descriptor.set != nil {
		_, err := descriptor.set.Invoke(vm, this, []JSValue{value}, CallFlags{})
		// descriptor used but remains unchanged
		return err
	} else {
		descriptor.value = value
	}

	// descriptor has been created/changed
	this.descriptors[name] = descriptor
	return nil
}
func (this *JSObject) DefineProperty(name Name, descriptor Descriptor) {
	descriptor.writable = true
	descriptor.configurable = true
	descriptor.enumerable = true
	this.descriptors[name] = descriptor
}
func (this *JSObject) DeleteProperty(name Name) bool {
	_, wasThere := this.descriptors[name]
	delete(this.descriptors, name)
	return wasThere
}
func (this *JSObject) GetIndex(ndx uint) (JSValue, error) {
	if this.arrayPart != nil {
		return this.arrayPart[ndx], nil
	} else {
		return this.GetProperty(NameStr(string(ndx)), nil)
	}
}
func (this *JSObject) SetIndex(ndx int, value JSValue) {
	if this.arrayPart != nil {
		for len(this.arrayPart) < ndx+1 {
			this.arrayPart = append(this.arrayPart, JSUndefined{})
		}
		this.arrayPart[ndx] = value
	} else {
		err := this.SetProperty(NameStr(string(ndx)), value, nil)
		if err != nil {
			panic("bug: error in SetIndex")
		}
	}
}

func NewNativeFunction(paramNames []string, cb NativeCallback) JSObject {
	return JSObject{
		Prototype:   &ProtoFunction,
		descriptors: make(map[Name]Descriptor),
		funcPart: &FunctionPart{
			isStrict: true,
			native:   cb,
			params:   paramNames,
			body:     nil,
		},
	}
}
func (callee *JSObject) Invoke(vm *VM, this JSValue, args []JSValue, flags CallFlags) (ret JSValue, err error) {
	fp := callee.funcPart
	if fp == nil {
		err := fmt.Errorf("callee is not a function")
		return JSUndefined{}, err
	}

	if !flags.isNew && !fp.isStrict {
		// do this-substitution
		_, isUnd := this.(JSUndefined)
		_, isNul := this.(JSNull)
		if isUnd || isNul {
			this = &vm.globalObject
		}
		this, err = vm.coerceToObject(this)
		if err != nil {
			return
		}
	}

	ret = JSUndefined{}
	vm.WithScope(func() {
		vm.curScope.this = this
		vm.curScope.call = &ScopeCall{}
		vm.curScope.isSetStrict = fp.isStrict

		params := fp.params
		if params != nil {
			for len(args) < len(params) {
				args = append(args, JSUndefined{})
			}

			for i, name := range params {
				value := args[i]
				vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr(name), value)
			}
		}

		argsArray := NewJSArray()
		argsArray.arrayPart = make([]JSValue, len(args))
		copy(argsArray.arrayPart, args)

		vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr("arguments"), &argsArray)

		vm.WithScope(func() {
			if fp.native != nil {
				ret, err = fp.native(vm, this, args, CallFlags{})
			} else if fp.body != nil {
				check := vm.curScope
				vm.runStmt(fp.body)

				if check != vm.curScope {
					panic("scope stack manipulated!")
				}
				ret = vm.curScope.call.returnValue

			} else {
				panic("invalid function: neither native nor JS part is initialized")
			}
		})
	})
	return
}

// TODO Delete if this does not help ensure we do comparison by pointer
func (this *JSObject) Is(other *JSObject) bool {
	return this == other
}

func NewJSArray() (obj JSObject) {
	obj = NewJSObject(&ProtoArray)
	obj.arrayPart = make([]JSValue, 0, 8)
	return
}

type JSBigInt uint64

func (v JSBigInt) Category() JSVCategory { return VBigInt }

var (
	ProtoObject   = NewJSObject(nil)
	ProtoFunction = NewJSObject(&ProtoObject)
	ProtoNumber   = NewJSObject(&ProtoObject)
	ProtoBigint   = NewJSObject(&ProtoObject)
	ProtoBoolean  = NewJSObject(&ProtoObject)
	ProtoString   = NewJSObject(&ProtoObject)
	ProtoSymbol   = NewJSObject(&ProtoObject)
	ProtoArray    = NewJSObject(&ProtoObject)
	ProtoRegexp   = NewJSObject(&ProtoObject)
)

type VMError error

type ReturnValue struct{ JSValue }

func (rv ReturnValue) Error() string {
	return "(a value was returned)"
}

type ProgramException struct {
	exceptionValue JSValue
	context        ProgramContext
}

func (pexc ProgramException) message() string {
	if excStr, isStr := pexc.exceptionValue.(JSString); isStr {
		return string(excStr)
	}

	if excObj, isObj := pexc.exceptionValue.(*JSObject); isObj {
		msgValue, err := excObj.GetOwnProperty(NameStr("message"), nil)
		if err != nil {
			return fmt.Sprintf("while getting error's `message` property: %s", err)
		}
		if msgStr, isStr := msgValue.(JSString); isStr {
			return string(msgStr)
		}
		return "(neither string nor object)"
	}

	return "(neither string nor object)"
}
func (pexc ProgramException) Error() string {
	msg := pexc.message()
	return fmt.Sprintf("JS exception: %s", msg)
}

type ProgramContext struct {
	fileStack []*parserFile.File
	stack     []ContextItem
}
type ContextItem struct {
	file       *parserFile.File
	start, end parserFile.Position
	node       ast.Node
}

func (this *ProgramContext) PushFile(file *parserFile.File) {
	this.fileStack = append(this.fileStack, file)
}
func (this *ProgramContext) PopFile(check *parserFile.File) {
	sl := len(this.fileStack)
	if sl == 0 {
		panic("bug: ProgramContext: PopFile called on empty stack")
	}
	if this.fileStack[sl-1] != check {
		panic("bug: ProgramContext: stack was not managed purely with PushFile/PopFile")

	}
	this.fileStack = this.fileStack[:sl-1]
}

func (this *ProgramContext) Push(node ast.Node) {
	if len(this.fileStack) == 0 {
		panic("bug: ProgramContext: Push called without calling PushFile() first ")
	}

	file := this.fileStack[len(this.fileStack)-1]
	item := ContextItem{
		file:  file,
		start: *file.Position(node.Idx0()),
		end:   *file.Position(node.Idx1()),
		node:  node,
	}
	this.stack = append(this.stack, item)
}
func (this *ProgramContext) Pop(nodeCheck ast.Node) {
	sl := len(this.stack)
	if sl == 0 {
		panic("bug: ProgramContext.Pop but stack already empty")
	}

	if nodeCheck != nil && nodeCheck != this.stack[sl-1].node {
		panic("bug: nodeCheck != stack top")
	}

	this.stack = this.stack[:sl-1]
}

type DeclKind uint8

const (
	DeclVar DeclKind = iota
	DeclLet
	DeclConst
)

type Environment interface {
	defineVar(scope *Scope, kind DeclKind, name Name, value JSValue)
	setVar(scope *Scope, name Name, value JSValue, vm *VM) error
	lookupVar(scope *Scope, name Name) JSValue
	deleteVar(scope *Scope, name Name) bool
}

type Scope struct {
	parent      *Scope
	isSetStrict bool
	env         Environment
	vars        map[Name]JSValue
	doNotDelete map[Name]struct{}
	this        JSValue

	// non-nil iff this scope is a function call's "wrapper" scope.
	//  - each function has at least 2 nested scopes:
	//     - wrapper: only arguments are defined
	//     - body: this corresponds to the function's body in { }
	// this allows us to allow var to redefine an argument in the function
	call *ScopeCall
}

type ScopeCall struct {
	returnValue JSValue
}

func isStrict(s *Scope) (ret bool) {
	for ; s != nil; s = s.parent {
		if s.isSetStrict {
			return true
		}
	}
	return false
}

func getRoot(s *Scope) *Scope {
	for s.parent != nil {
		s = s.parent
	}
	return s
}

func newScope(env Environment) (ret Scope) {
	ret.env = env
	ret.vars = make(map[Name]JSValue)
	ret.doNotDelete = make(map[Name]struct{})
	return
}
func newVarScope() Scope {
	return newScope(DirectEnv(make(map[Name]JSValue)))
}

type DirectEnv map[Name]JSValue

func (denv DirectEnv) defineVar(scope *Scope, kind DeclKind, name Name, value JSValue) {
	if kind == DeclVar && scope.call == nil && scope.parent != nil {
		scope.parent.env.defineVar(scope.parent, kind, name, value)
		return
	}

	_, alreadyDefined := denv[name]
	if alreadyDefined {
		// redefinition! => discard
	} else {
		denv[name] = value
	}
}

func (denv DirectEnv) setVar(scope *Scope, name Name, value JSValue, vm *VM) error {
	if vm == nil {
		panic("vm not passed (required to throw ReferenceError)")
	}

	_, alreadyDefined := denv[name]
	if alreadyDefined {
		denv[name] = value
	} else if parent := scope.parent; parent != nil {
		parent.env.setVar(parent, name, value, vm)
	} else {
		return vm.ThrowError("NameError", "unbound variable: "+name.String())
	}
	return nil
}

func (denv DirectEnv) lookupVar(scope *Scope, name Name) JSValue {
	value, defined := denv[name]
	if defined && value.Category() != VUndefined {
		return value
	}
	if scope.parent != nil {
		return scope.parent.env.lookupVar(scope.parent, name)
	}
	return JSUndefined{}
}

func (denv DirectEnv) deleteVar(scope *Scope, name Name) bool {
	_, dnd := scope.doNotDelete[name]
	if dnd {
		return false
	}

	_, defined := denv[name]
	delete(denv, name)
	return defined
}

type ObjectEnv struct{ *JSObject }

func (oenv ObjectEnv) defineVar(_ *Scope, kind DeclKind, name Name, value JSValue) {
	// TODO we're not using kind yet
	oenv.SetProperty(name, value, nil)
}

func (oenv ObjectEnv) setVar(scope *Scope, name Name, value JSValue, vm *VM) error {
	if scope.isSetStrict {
		if !oenv.HasOwnProperty(name) {
			msg := fmt.Sprintf("assignment to undeclared global variable: ", name)
			return vm.ThrowError("ReferenceError", msg)
		}
	}
	return oenv.SetProperty(name, value, vm)
}

func (oenv ObjectEnv) lookupVar(scope *Scope, name Name) JSValue {
	value, err := oenv.GetProperty(name, nil)
	if err != nil {
		panic("unexpected error in env.LookupVar")
	}
	return value
}

func (oenv ObjectEnv) deleteVar(scope *Scope, name Name) bool {
	_, dnd := scope.doNotDelete[name]
	if dnd {
		return false
	}
	return oenv.DeleteProperty(name)
}

type VM struct {
	globalObject JSObject
	curScope     *Scope
	synCtx       ProgramContext
}

func NewVM() (vm VM) {
	vm.globalObject = createGlobalObject()
	return
}

func createGlobalObject() JSObject {
	// Nothing for now!
	return NewJSObject(&ProtoObject)
}

func (vm *VM) WithScope(action func()) {
	saveScope := vm.curScope

	innerScope := newVarScope()
	innerScope.parent = vm.curScope

	vm.curScope = &innerScope
	action()
	vm.curScope = saveScope
}

func (vm *VM) CurCallWrapper() *Scope {
	for scope := vm.curScope; scope != nil; scope = scope.parent {
		if scope.call != nil {
			return scope
		}
	}
	return nil
}

func unsupportedNode(node ast.Node) {
	panic(fmt.Sprintf("unsupported node: %v", node))
}

func (vm *VM) RunScriptFile(path, text string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	program, err := parser.ParseFile(nil, path, f, 0)
	if err != nil {
		return err
	}

	vm.synCtx.PushFile(program.File)
	defer vm.synCtx.PopFile(program.File)
	return vm.runProgram(program)
}

func (vm *VM) runProgram(program *ast.Program) error {
	vm.synCtx.Push(program)
	defer vm.synCtx.Pop(program)

	if vm.curScope != nil {
		panic("bug: nested program!")
	}

	topScope := newScope(ObjectEnv{&vm.globalObject})
	if hasUseStrict(program.Body) {
		topScope.isSetStrict = true
	}

	saveScope := vm.curScope
	vm.curScope = &topScope
	defer func() { vm.curScope = saveScope }()

	return vm.runStmts(program.Body)
}

func (vm *VM) runStmts(stmts []ast.Statement) error {
	for _, stmt := range stmts {
		err := vm.runStmt(stmt)
		if err != nil {
			return err
		}
	}
	return nil
}

func hasUseStrict(body []ast.Statement) bool {
	if len(body) == 0 {
		return false
	}

	es, isES := body[0].(*ast.ExpressionStatement)
	if !isES {
		return false
	}

	lit, isLiteral := es.Expression.(*ast.StringLiteral)
	if !isLiteral {
		return false
	}

	return lit.Value == "use strict"
}

func (vm *VM) runStmt(stmt ast.Statement) (err error) {
	if stmt == nil {
		return nil
	}

	switch stmt := stmt.(type) {
	case *ast.EmptyStatement:
		return nil
	case *ast.BlockStatement:
		vm.WithScope(func() {
			err = vm.runStmts(stmt.List)
		})
		return

	case *ast.TryStatement:
		vm.WithScope(func() {
			err = vm.runStmt(stmt.Body)
		})

		if exc, isExc := err.(*ProgramException); isExc {
			if stmt.Catch != nil {
				param := NameStr(stmt.Catch.Parameter.Name)
				vm.WithScope(func() {
					vm.curScope.env.defineVar(vm.curScope, DeclVar, param, exc.exceptionValue)
					vm.curScope.doNotDelete[param] = struct{}{}
					err = vm.runStmt(stmt.Catch.Body)
				})
			}
		} else if err != nil {
			// not a JS exception: interrupt execution
			return err
		}

		vm.runStmt(stmt.Finally)

		return err

	case *ast.ThrowStatement:
		exc, err := vm.evalExpr(stmt.Argument)
		if err == nil {
			err = vm.makeException(exc)
		}
		return err

	case *ast.FunctionStatement:
		_, err = defineFunction(vm, *stmt.Function)
		return err

	case *ast.ExpressionStatement:
		_, err = vm.evalExpr(stmt.Expression)
		return

	case *ast.IfStatement:
		testVal, err := vm.evalExpr(stmt.Test)
		if err != nil {
			return err
		}

		if vm.isTruthy(testVal) {
			return vm.runStmt(stmt.Consequent)
		} else {
			return vm.runStmt(stmt.Alternate)
		}

	case *ast.VariableStatement:
		for _, item := range stmt.List {
			_, err = vm.evalExpr(item)
			if err != nil {
				return
			}
		}

	case *ast.ReturnStatement:
		retVal, err := vm.evalExpr(stmt.Argument)
		if err == nil {
			err = ReturnValue{retVal}
		}
		return err

	default:
		unsupportedNode(stmt)
	}

	return fmt.Errorf("unhandled node type %s", reflect.TypeOf(stmt).Name())
}

func defineFunction(vm *VM, literal ast.FunctionLiteral) (fnp *JSObject, err error) {
	fn := vm.makeFunction(literal.ParameterList, literal.Body, FuncFlags{})
	fnp = &fn

	if literal.Name != nil {
		nameStr := literal.Name.Name
		err = fn.SetProperty(NameStr("name"), JSString(nameStr), vm)
		if err == nil {
			vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr(nameStr), fnp)
		}
	}

	return
}

func (vm *VM) isTruthy(val JSValue) bool {
	switch spec := val.(type) {
	case JSBigInt:
		return spec != 0
	case JSBoolean:
		return bool(spec)
	case JSNull:
		return false
	case JSNumber:
		return spec != 0.0
	case JSString:
		return len(spec) > 0
	case JSUndefined:
		return false
	// case *JSObject:
	default:
		panic(fmt.Sprintf("isTruthy not implemented for value: %#v", val))
	}
}

type FuncFlags struct {
	noInheritStrict bool
}

func (vm *VM) makeFunction(params *ast.ParameterList, body ast.Statement, opts FuncFlags) (fn JSObject) {
	paramNames := make([]string, len(params.List))
	for i, ident := range params.List {
		paramNames[i] = ident.Name
	}

	fn = NewJSObject(&ProtoFunction)
	blockBody, isBlock := body.(*ast.BlockStatement)
	fn.funcPart = &FunctionPart{
		isStrict: (isStrict(vm.curScope) && !opts.noInheritStrict) || (isBlock && hasUseStrict(blockBody.List)),
		native:   nil,
		params:   paramNames,
		body:     body,
	}
	return
}

func (vm *VM) evalExpr(expr ast.Expression) (value JSValue, err error) {
	value = JSUndefined{}

	switch expr := expr.(type) {
	case *ast.AssignExpression:
		value, err = vm.evalExpr(expr.Right)
		if err != nil {
			return
		}

		switch expr.Operator {
		case token.ASSIGN:
			// nothing, we're done
		// case token.ADD_ASSIGN:
		default:
			err = fmt.Errorf("unsupported/unimplemented assignment operator: %s", expr.Operator)
			return
		}

		err = doAssignment(vm, expr.Left, value)
		return

	case *ast.FunctionLiteral:
		return defineFunction(vm, *expr)

	case *ast.ObjectLiteral:

	// case *ast.ArrayLiteral:
	// case *ast.AssignExpression:
	// case *ast.BadExpression:
	// case *ast.BinaryExpression:
	// case *ast.BooleanLiteral:
	// case *ast.BracketExpression:
	// case *ast.CallExpression:
	// case *ast.ConditionalExpression:
	// case *ast.DotExpression:
	// case *ast.EmptyExpression:
	// case *ast.Identifier:
	// case *ast.NewExpression:
	// case *ast.NullLiteral:
	// case *ast.NumberLiteral:
	// case *ast.RegExpLiteral:
	// case *ast.SequenceExpression:
	// case *ast.StringLiteral:
	// case *ast.ThisExpression:
	// case *ast.UnaryExpression:
	// case *ast.VariableExpression:
	default:
		panic(fmt.Sprintf("unexpected ast.Expression: %#v", expr))
	}
}

func doAssignment(vm *VM, target ast.Expression, value JSValue) error {
	switch target := target.(type) {
	case *ast.DotExpression:
		objValue, err := vm.evalExpr(target.Left)
		if err != nil {
			return err
		}

		obj, err := vm.coerceToObject(objValue)
		if err != nil {
			return err
		}

		propertyName := target.Identifier.Name
		return obj.SetProperty(NameStr(propertyName), value, vm)

	case *ast.BracketExpression:
		objValue, err := vm.evalExpr(target.Left)
		if err != nil {
			return err
		}

		obj, err := vm.coerceToObject(objValue)
		if err != nil {
			return err
		}

		propertyVal, err := vm.evalExpr(target.Member)
		if err != nil {
			return err
		}

		switch propertyVal := propertyVal.(type) {
		case JSString:
			return obj.SetProperty(NameStr(string(propertyVal)), value, vm)
		case JSNumber:
			obj.SetIndex(int(propertyVal), value)
			return nil
		default:
			return fmt.Errorf("object index/property is neither number nor string")
		}

	default:
		return fmt.Errorf("invalid or unsupported assignment target: %#v", target)
	}

}

func (vm *VM) coerceToObject(value JSValue) (obj *JSObject, err error) {
	var consName string

	switch specific := value.(type) {
	case JSBigInt:
		// weird stupid case. why is BigInt not a constructor?
		obj = new(JSObject)
		*obj = NewJSObject(&ProtoBigint)
		obj.primBigInt = specific
		return

	case JSNumber:
		consName = "Number"

	case JSBoolean:
		consName = "Boolean"

	case JSString:
		consName = "String"

	case JSNull:
	case JSUndefined:
	default:
		msg := fmt.Sprintf("can't convert to object: %#v", value)
		err = vm.ThrowError("TypeError", msg)
		return nil, err

	case *JSObject:
		return specific, nil
	}

	consGen, err := vm.globalObject.GetOwnProperty(NameStr(consName), vm)
	cons, isObj := consGen.(*JSObject)
	if !isObj {
		panic(fmt.Sprintf("bug: constructor «%s» is not an object", consName))
	}
	return vm.DoNew(cons, []JSValue{value})
}

func (vm *VM) coerceToBoolean(value JSValue) JSBoolean {
	switch spec := value.(type) {
	case JSBigInt:
		return spec != 0
	case JSBoolean:
		return spec
	case JSNull:
		return false
	case JSNumber:
		return spec != 0.0
	case *JSObject:
		return true
	case JSString:
		return spec != ""
	case JSUndefined:
		return false
	default:
		panic(fmt.Sprintf("coerceToBoolean: invalid value type: %#v", value))
	}
}

func (vm *VM) DoNew(cons *JSObject, args []JSValue) (obj *JSObject, err error) {
	obj = new(JSObject)
	ret, err := cons.Invoke(vm, obj, args, CallFlags{isNew: true})
	if err != nil {
		return
	}
	if retObj, isObj := ret.(*JSObject); isObj {
		obj = retObj
	}
	return
}

func (vm *VM) ThrowError(className string, message string) error {
	exc := NewJSObject(&ProtoObject)
	err := exc.SetProperty(NameStr("message"), JSString(message), vm)
	if err != nil {
		panic("SetProperty must not fail here!")
	}
	return ProgramException{
		exceptionValue: &exc,
		context:        vm.synCtx,
	}

}

func (vm *VM) makeException(excValue JSValue) error {
	return ProgramException{
		exceptionValue: excValue,
		context:        ProgramContext(vm.synCtx),
	}
}
