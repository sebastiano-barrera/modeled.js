package modeledjs

import (
	"fmt"
	"io"
	"math"
	"os"
	"reflect"
	"strconv"
	"strings"

	"github.com/robertkrimen/otto/ast"
	parserFile "github.com/robertkrimen/otto/file"
	"github.com/robertkrimen/otto/parser"
	"github.com/robertkrimen/otto/token"
)

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
	descriptors map[Name]*Descriptor

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
	isStrict     bool
	native       NativeCallback
	params       []string
	body         ast.Statement
	lexicalScope *Scope

	file *parserFile.File
	name string
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

type ErrUndefinedProperty struct{ name Name }

func (err ErrUndefinedProperty) Error() string {
	if err.name.isSymbol {
		return fmt.Sprintf("undefined property: %s", err.name.string)
	} else {
		return fmt.Sprintf("undefined property: @%s", err.name.string)
	}
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
		descriptors: make(map[Name]*Descriptor),
	}
}

func (jso *JSObject) resolveDescriptor(descriptor *Descriptor, vm *VM) (retVal JSValue, err error) {
	if descriptor.get == nil {
		retVal = descriptor.value
		return
	}
	if vm == nil {
		panic("bug: looking up described value but vm not passed")
	}
	return descriptor.get.Invoke(vm, jso, []JSValue{}, CallFlags{})
}
func (jso *JSObject) getOwnPropertyDescriptor(name Name) (*Descriptor, bool) {
	// TODO Return a pointer?
	d, ok := jso.descriptors[name]
	return d, ok
}
func (jso *JSObject) GetOwnProperty(name Name, vm *VM) (JSValue, error) {
	descriptor, isThere := jso.descriptors[name]
	if !isThere {
		return JSUndefined{}, nil
	}
	return jso.resolveDescriptor(descriptor, vm)
}
func (jso *JSObject) HasOwnProperty(name Name) bool {
	_, isThere := jso.descriptors[name]
	return isThere
}
func (jso *JSObject) GetProperty(name Name, vm *VM) (JSValue, error) {
	object := jso
	for {
		if object == nil {
			return nil, ErrUndefinedProperty{name: name}
		}
		descriptor, isThere := object.getOwnPropertyDescriptor(name)
		if isThere {
			return jso.resolveDescriptor(descriptor, vm)
		}
		object = object.Prototype
	}

}
func (jso *JSObject) SetProperty(name Name, value JSValue, vm *VM) error {
	var descriptor *Descriptor
	isThere := false

	for object := jso; object != nil; object = object.Prototype {
		descriptor, isThere = object.getOwnPropertyDescriptor(name)
		if isThere {
			break
		}
	}

	// TODO Honor writable, configurable, etc.
	if !isThere {
		if value == nil {
			panic("value can't be nil here")
		}

		jso.descriptors[name] = &Descriptor{
			value:        value,
			configurable: false,
			enumerable:   false,
			writable:     false,
		}
		return nil
	} else if descriptor.set != nil {
		_, err := descriptor.set.Invoke(vm, jso, []JSValue{value}, CallFlags{})
		// descriptor used but remains unchanged
		return err
	} else {
		descriptor.value = value
		return nil
	}
}
func (jso *JSObject) getOrDefineProperty(name Name) (ds *Descriptor) {
	ds, isThere := jso.getOwnPropertyDescriptor(name)
	if !isThere {
		ds = jso.DefineProperty(name, Descriptor{value: JSUndefined{}})
	}
	return
}

func (jso *JSObject) DefineProperty(name Name, descriptor Descriptor) *Descriptor {
	descriptor.writable = true
	descriptor.configurable = true
	descriptor.enumerable = true
	dp := &descriptor
	jso.descriptors[name] = dp
	return dp
}
func (jso *JSObject) DeleteProperty(name Name) bool {
	_, wasThere := jso.descriptors[name]
	delete(jso.descriptors, name)
	return wasThere
}
func (jso *JSObject) GetIndex(ndx uint) (JSValue, error) {
	if jso.arrayPart != nil {
		return jso.arrayPart[ndx], nil
	} else {
		return jso.GetProperty(NameStr(fmt.Sprint(ndx)), nil)
	}
}
func (jso *JSObject) SetIndex(ndx int, value JSValue) {
	if jso.arrayPart != nil {
		for len(jso.arrayPart) < ndx+1 {
			jso.arrayPart = append(jso.arrayPart, JSUndefined{})
		}
		jso.arrayPart[ndx] = value
	} else {
		err := jso.SetProperty(NameStr(fmt.Sprint(ndx)), value, nil)
		if err != nil {
			panic("bug: error in SetIndex")
		}
	}
}

func NewNativeFunction(paramNames []string, cb NativeCallback) JSObject {
	return JSObject{
		Prototype:   &ProtoFunction,
		descriptors: make(map[Name]*Descriptor),
		funcPart: &FunctionPart{
			isStrict: true,
			native:   cb,
			params:   paramNames,
			body:     nil,
			file:     nil,
			name:     "",
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

	saveScope := vm.curScope
	vm.curScope = fp.lexicalScope
	defer func() { vm.curScope = saveScope }()

	ret = JSUndefined{}
	vm.withScope(func() {
		vm.curScope.call = &ScopeCall{this: this}
		vm.curScope.isSetStrict = fp.isStrict

		// the function's name is not overridable within the function itself
		if fp.name != "" {
			vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr(fp.name), callee)
		}

		if fp.file != nil {
			vm.synCtx.PushFile(fp.file)
			defer vm.synCtx.PopFile(fp.file)
		}

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

		vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr("arguments"), argsArray)

		vm.withScope(func() {
			if fp.native != nil {
				ret, err = fp.native(vm, this, args, CallFlags{})
			} else if fp.body != nil {
				check := vm.curScope
				err = vm.runStmt(fp.body)
				if check != vm.curScope {
					panic("scope stack manipulated!")
				}

				if retWrapper, isReturn := err.(ReturnValue); isReturn {
					ret = retWrapper.JSValue
					err = nil
				}

			} else {
				panic("invalid function: neither native nor JS part is initialized")
			}
		})
	})
	return
}

func NewJSArray() (obj *JSObject) {
	obj = new(JSObject)
	*obj = NewJSObject(&ProtoArray)
	obj.arrayPart = make([]JSValue, 0, 8)
	return
}

type JSBigInt int64

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

func init() {
	object_toString := NewNativeFunction(nil, func(_ *VM, _ JSValue, _ []JSValue, _ CallFlags) (JSValue, error) {
		return JSString("[object Object]"), nil
	})
	ProtoObject.SetProperty(NameStr("toString"), &object_toString, nil)

	object_hasOwnProperty := NewNativeFunction(nil, func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
		subjectObj, err := vm.coerceToObject(subject)
		if err != nil {
			return nil, err
		}

		if len(args) == 0 {
			return JSBoolean(false), nil
		}
		name, err := vm.coerceToString(args[0])
		if err != nil {
			return nil, err
		}

		ret := subjectObj.HasOwnProperty(NameStr(string(name)))
		return JSBoolean(ret), nil
	})
	ProtoObject.SetProperty(NameStr("hasOwnProperty"), &object_hasOwnProperty, nil)

	function_bind := NewNativeFunction([]string{"forcedThis"}, func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
		outerInvokable, err := vm.coerceToObject(subject)
		if err != nil {
			return nil, err
		}
		if outerInvokable.funcPart != nil {
			return nil, vm.ThrowError("TypeError", "Function.prototype.bind: `this` is not invokable")
		}

		var forcedThis JSValue
		if len(args) == 0 {
			forcedThis = JSUndefined{}
		} else {
			forcedThis = args[0]
		}

		wrapper := NewNativeFunction(outerInvokable.funcPart.params, func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
			return outerInvokable.Invoke(vm, forcedThis, args, CallFlags{})
		})
		return &wrapper, nil
	})
	ProtoFunction.SetProperty(NameStr("bind"), &function_bind, nil)

	function_call := NewNativeFunction([]string{"forcedThis"}, func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
		outerInvokable, err := vm.coerceToObject(subject)
		if err != nil {
			return nil, err
		}
		if outerInvokable.funcPart != nil {
			return nil, vm.ThrowError("TypeError", "Function.prototype.bind: `this` is not invokable")
		}

		var forcedThis JSValue
		if len(args) == 0 {
			forcedThis = JSUndefined{}
		} else {
			forcedThis = args[0]
			args = args[1:]
		}

		return outerInvokable.Invoke(vm, forcedThis, args, CallFlags{})
	})
	ProtoFunction.SetProperty(NameStr("call"), &function_call, nil)

	function_apply := NewNativeFunction([]string{"forcedThis", "args"}, func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
		outerInvokable, err := vm.coerceToObject(subject)
		if err != nil {
			return nil, err
		}
		if outerInvokable.funcPart != nil {
			return nil, vm.ThrowError("TypeError", "Function.prototype.bind: `this` is not invokable")
		}

		var forcedThis JSValue = JSUndefined{}
		var argsArray []JSValue = nil

		if len(args) >= 1 {
			forcedThis = args[0]
		}
		if len(args) >= 2 {
			argsArrayObj, err := vm.coerceToObject(args[1])
			if err != nil {
				return nil, err
			}
			argsArray = argsArrayObj.arrayPart
		}

		return outerInvokable.Invoke(vm, forcedThis, argsArray, CallFlags{})
	})
	ProtoFunction.SetProperty(NameStr("apply"), &function_apply, nil)

	function_toString := NewNativeFunction(nil, func(vm *VM, subject JSValue, _ []JSValue, _ CallFlags) (JSValue, error) {
		subjectObj, err := vm.coerceToObject(subject)
		if err != nil {
			return nil, err
		}

		fp := subjectObj.funcPart
		if fp == nil {
			return nil, vm.ThrowError("TypeError", "Function.prototype.toString: 'this' is not a function")
		}

		var s string
		if fp.native != nil {
			s = "[Function <native>]"
		} else if pos := fp.file.Position(fp.body.Idx0()); pos != nil {
			s = fmt.Sprintf(
				"[Function %s:%d:%d]",
				pos.Filename,
				pos.Line,
				pos.Column,
			)
		} else {
			s = "[Function JS <unknown pos>]"
		}

		return JSString(s), nil
	})
	ProtoObject.SetProperty(NameStr("toString"), &function_toString, nil)

}

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

	lines := make([]string, 1+len(pexc.context.stack))
	lines[0] = fmt.Sprintf("JS exception: %s", msg)
	for i, item := range pexc.context.stack {
		s := &item.start
		lines[1+i] = fmt.Sprintf(" JS @ %s:%d:%d %s", s.Filename, s.Line, s.Column,
			reflect.TypeOf(item.node).String(),
		)
	}
	return strings.Join(lines, "\n")
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

func (pctx *ProgramContext) PushFile(file *parserFile.File) {
	pctx.fileStack = append(pctx.fileStack, file)
}
func (pctx *ProgramContext) PopFile(check *parserFile.File) {
	sl := len(pctx.fileStack)
	if sl == 0 {
		panic("bug: ProgramContext: PopFile called on empty stack")
	}
	if pctx.fileStack[sl-1] != check {
		panic("bug: ProgramContext: stack was not managed purely with PushFile/PopFile")

	}
	pctx.fileStack = pctx.fileStack[:sl-1]
}

func (pctx *ProgramContext) Push(node ast.Node) {
	if node == nil {
		return
	}

	if len(pctx.fileStack) == 0 {
		panic("bug: ProgramContext: Push called without calling PushFile() first ")
	}

	file := pctx.fileStack[len(pctx.fileStack)-1]
	item := ContextItem{
		file: file,
		node: node,
	}
	startp := file.Position(node.Idx0())
	if startp != nil {
		item.start = *startp
	}
	endp := file.Position(node.Idx1())
	if endp != nil {
		item.end = *endp
	}

	pctx.stack = append(pctx.stack, item)
}
func (pctx *ProgramContext) Pop(nodeCheck ast.Node) {
	if nodeCheck == nil {
		return
	}

	sl := len(pctx.stack)
	if sl == 0 {
		panic("bug: ProgramContext.Pop but stack already empty")
	}

	if nodeCheck != pctx.stack[sl-1].node {
		panic("bug: nodeCheck != stack top")
	}
	pctx.stack = pctx.stack[:sl-1]
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
	lookupVar(scope *Scope, name Name) (JSValue, bool)
	deleteVar(scope *Scope, name Name) bool
}

type Scope struct {
	parent      *Scope
	isSetStrict bool
	env         Environment
	vars        map[Name]JSValue
	doNotDelete map[Name]struct{}

	// non-nil iff this scope is a function call's "wrapper" scope.
	//  - each function has at least 2 nested scopes:
	//     - wrapper: only arguments are defined
	//     - body: this corresponds to the function's body in { }
	// this allows us to allow var to redefine an argument in the function
	call *ScopeCall
}

type ScopeCall struct {
	this JSValue
}

func isStrict(s *Scope) (ret bool) {
	for ; s != nil; s = s.parent {
		if s.isSetStrict {
			return true
		}
	}
	return false
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

func (denv DirectEnv) lookupVar(scope *Scope, name Name) (value JSValue, defined bool) {
	value, defined = denv[name]
	if defined {
		return
	}
	if scope.parent != nil {
		return scope.parent.env.lookupVar(scope.parent, name)
	}
	return nil, false
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
			msg := fmt.Sprintf("assignment to undeclared global variable: %s", name)
			return vm.ThrowError("ReferenceError", msg)
		}
	}
	return oenv.SetProperty(name, value, vm)
}

func (oenv ObjectEnv) lookupVar(scope *Scope, name Name) (value JSValue, defined bool) {
	value, err := oenv.GetProperty(name, nil)
	if _, isUndef := err.(ErrUndefinedProperty); isUndef {
		return nil, false
	} else if err != nil {
		panic("unexpected error in env.LookupVar")
	}
	return value, true
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

func createGlobalObject() (G JSObject) {
	G = NewJSObject(&ProtoObject)

	consString := addPrimitiveWrapperConstructor(
		&G, "String", &ProtoString,
		func(vm *VM, jsv JSValue) (JSString, error) {
			return vm.coerceToString(jsv)
		},
		func(obj *JSObject, jss JSString) {
			obj.primString = jss
		},
	)

	consBoolean := addPrimitiveWrapperConstructor(
		&G, "Boolean", &ProtoBoolean,
		func(vm *VM, jsv JSValue) (JSBoolean, error) {
			return vm.coerceToBoolean(jsv), nil
		},
		func(obj *JSObject, jsb JSBoolean) {
			obj.primBoolean = jsb
		},
	)

	consNumber := addPrimitiveWrapperConstructor(
		&G, "Number", &ProtoNumber,
		func(vm *VM, jsv JSValue) (JSNumber, error) {
			return vm.coerceToNumber(jsv)
		},
		func(obj *JSObject, jsn JSNumber) {
			obj.primNumber = jsn
		},
	)

	// BigInt is slightly different (not a constructor)
	consBigInt := NewNativeFunction(
		[]string{"primitiveValue"},
		func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
			if flags.isNew {
				// WHY THOUGH
				return nil, vm.ThrowError("TypeError", "BigInt is not a constructor")
			}

			var arg JSValue
			if len(args) == 0 {
				arg = JSUndefined{}
			} else {
				arg = args[0]
			}

			return vm.coerceToBigInt(arg)
		})
	G.SetProperty(NameStr("BigInt"), &consBigInt, nil)

	consObject := NewNativeFunction(
		[]string{"value"},
		func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
			var value JSValue = JSUndefined{}
			if len(args) > 0 {
				value = args[0]
			}

			var constructor *JSObject
			switch spec := value.(type) {
			case JSBigInt:
				constructor = &consBigInt
			case JSBoolean:
				constructor = consBoolean
			case JSNumber:
				constructor = consNumber
			case JSString:
				constructor = consString
			case *JSObject:
				return spec, nil
			case JSUndefined, JSNull:
				emptyObj := NewJSObject(&ProtoObject)
				return &emptyObj, nil
			default:
				panic(fmt.Sprintf("unexpected modeledjs.JSValue: %#v", value))
			}

			initObj := NewJSObject(&ProtoObject)
			return constructor.Invoke(vm, &initObj, args[:1], CallFlags{isNew: true})
		},
	)
	G.SetProperty(NameStr("Object"), &consObject, nil)

	consArray := NewNativeFunction(
		nil,
		func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (ret JSValue, err error) {
			obj := NewJSArray()
			obj.arrayPart = args
			return obj, nil
		},
	)
	G.SetProperty(NameStr("Array"), &consArray, nil)

	cashPrint := NewNativeFunction(
		[]string{"value"},
		func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
			var arg JSValue = JSUndefined{}
			if len(args) > 0 {
				arg = args[0]
			}
			fmt.Printf("$print: %#+v\n", arg)
			return JSUndefined{}, nil
		},
	)
	G.SetProperty(NameStr("$print"), &cashPrint, nil)

	return
}

func addPrimitiveWrapperConstructor[T JSValue](
	globalObj *JSObject,
	name string,
	prototype *JSObject,
	coercer func(vm *VM, jsv JSValue) (T, error),
	primInit func(obj *JSObject, prim T),
) *JSObject {
	constructor := NewNativeFunction(
		[]string{"primitiveValue"},
		func(vm *VM, subject JSValue, args []JSValue, flags CallFlags) (JSValue, error) {
			var arg JSValue
			if len(args) == 0 {
				arg = JSUndefined{}
			} else {
				arg = args[0]
			}

			prim, err := coercer(vm, arg)
			if err != nil {
				return JSUndefined{}, err
			}

			if flags.isNew {
				// discard subject, wrap into NEW object
				subjObj := NewJSObject(prototype)
				primInit(&subjObj, prim)
				return &subjObj, nil
			}

			return prim, nil
		})

	globalObj.SetProperty(NameStr(name), &constructor, nil)
	return &constructor
}

func (vm *VM) withScope(action func()) {
	saveScope := vm.curScope

	innerScope := newVarScope()
	innerScope.parent = vm.curScope

	vm.curScope = &innerScope
	action()
	vm.curScope = saveScope
}

func (vm *VM) RunScriptFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	return vm.RunScriptReader(path, f)
}

func (vm *VM) RunScriptReader(path string, f io.Reader) error {
	program, err := ParseReader(path, f)
	if err != nil {
		return err
	}

	vm.synCtx.PushFile(program.File)
	defer vm.synCtx.PopFile(program.File)
	return vm.runProgram(program)
}

func ParseReader(path string, f io.Reader) (*ast.Program, error) {
	program, err := parser.ParseFile(nil, path, f, 0)
	if err != nil {
		msg := err.Error()
		msg, found := strings.CutPrefix(msg, path)
		if found {
			msg, _ = strings.CutPrefix(msg, ": ")
			_, msg, _ = strings.Cut(msg, " ")
			_, msg, _ = strings.Cut(msg, " ")
		}
		return nil, fmt.Errorf("syntax error: %s", msg)
	}

	err = fixAndCheck(program.File, program)
	if err != nil {
		return nil, err
	}
	return program, nil
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

	vm.synCtx.Push(stmt)
	defer vm.synCtx.Pop(stmt)

	switch stmt := stmt.(type) {
	case *ast.EmptyStatement:
		return nil
	case *ast.BlockStatement:
		vm.withScope(func() {
			err = vm.runStmts(stmt.List)
		})
		return

	case *ast.TryStatement:
		vm.withScope(func() {
			err = vm.runStmt(stmt.Body)
		})

		if exc, isExc := err.(*ProgramException); isExc {
			if stmt.Catch != nil {
				param := NameStr(stmt.Catch.Parameter.Name)
				vm.withScope(func() {
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

		if vm.coerceToBoolean(testVal) {
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
		var retVal JSValue = JSUndefined{}
		if stmt.Argument != nil {
			retVal, err = vm.evalExpr(stmt.Argument)
		}
		if err == nil {
			err = ReturnValue{retVal}
		}
		return err

	default:
		return fmt.Errorf("unsupported node: %#v", stmt)
	}

	return nil
}

type BreakSignal struct{ label string }

func (sigb BreakSignal) Error() string {
	return "[break:" + sigb.label + "]"
}

type ContinueSignal struct{ label string }

func (sigc ContinueSignal) Error() string {
	return "[continue '" + sigc.label + "]"
}

func defineFunction(vm *VM, literal ast.FunctionLiteral) (fnp *JSObject, err error) {
	fn := vm.makeFunction(literal.ParameterList, literal.Body, FuncFlags{})

	proto := NewJSObject(&ProtoObject)
	fn.DefineProperty(NameStr("prototype"), Descriptor{
		value:        &proto,
		configurable: false,
		writable:     true,
		enumerable:   true,
	})

	fnp = &fn

	if literal.Name != nil {
		nameStr := literal.Name.Name
		fnp.funcPart.name = nameStr

		err = fn.SetProperty(NameStr("name"), JSString(nameStr), vm)
		if err == nil {
			vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr(nameStr), fnp)
		}
	}

	return
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
		isStrict:     (isStrict(vm.curScope) && !opts.noInheritStrict) || (isBlock && hasUseStrict(blockBody.List)),
		native:       nil,
		params:       paramNames,
		lexicalScope: vm.curScope,
		body:         body,
		file:         vm.synCtx.fileStack[len(vm.synCtx.fileStack)-1],
	}
	return
}

func (vm *VM) evalExpr(expr ast.Expression) (value JSValue, err error) {
	vm.synCtx.Push(expr)
	defer vm.synCtx.Pop(expr)

	switch expr := expr.(type) {
	case *ast.AssignExpression:
		value, err = vm.evalExpr(expr.Right)
		if err != nil {
			return
		}

		switch expr.Operator {
		case token.ASSIGN:
			// nothing, we're done

		case token.PLUS:
			var prevValue JSValue
			prevValue, err = vm.evalExpr(expr.Left)
			if err != nil {
				return nil, err
			}
			value, err = addition(vm, prevValue, value)
			if err != nil {
				return nil, err
			}

		default:
			err = fmt.Errorf("unsupported/unimplemented assignment operator: %s", expr.Operator)
			return
		}

		err = doAssignment(vm, expr.Left, value)
		return

	case *ast.FunctionLiteral:
		return defineFunction(vm, *expr)

	case *ast.ObjectLiteral:
		obj := NewJSObject(&ProtoObject)
		for _, prop := range expr.Value {
			var propValue JSValue
			propValue, err = vm.evalExpr(prop.Value)
			if err != nil {
				return nil, err
			}

			switch prop.Kind {
			case "init":
				obj.SetProperty(NameStr(prop.Key), propValue, vm)

			case "get":
			case "set":
				propObj, isObj := propValue.(*JSObject)
				if !isObj {
					return nil, fmt.Errorf("object literal getter must be object")
				}
				if propObj.funcPart == nil {
					return nil, fmt.Errorf("object literal getter must be function")
				}

				ds := obj.getOrDefineProperty(NameStr(prop.Key))
				if prop.Kind == "get" {
					ds.get = propObj
				} else {
					ds.set = propObj
				}

			default:
				err = fmt.Errorf("unsupported obj literal kind = %s", prop.Kind)
				return
			}
		}
		return &obj, nil

	case *ast.ArrayLiteral:
		obj := NewJSArray()
		for _, itemExpr := range expr.Value {
			value, err = vm.evalExpr(itemExpr)
			if err != nil {
				return nil, err
			}
			obj.arrayPart = append(obj.arrayPart, value)
		}
		return obj, nil

	case *ast.BinaryExpression:
		var left, right JSValue

		left, err = vm.evalExpr(expr.Left)
		if err != nil {
			return
		}
		right, err = vm.evalExpr(expr.Right)
		if err != nil {
			return
		}

		switch expr.Operator {
		case token.STRICT_EQUAL:
			bval := vm.strictEqual(left, right)
			return JSBoolean(bval), nil

		case token.STRICT_NOT_EQUAL:
			bval := vm.strictEqual(left, right)
			return JSBoolean(!bval), nil

		case token.EQUAL:
			bval, err := vm.looseEqual(left, right)
			return JSBoolean(bval), err

		case token.NOT_EQUAL:
			bval, err := vm.looseEqual(left, right)
			return JSBoolean(!bval), err

		case token.PLUS:
			return addition(vm, left, right)

		case token.MINUS, token.MULTIPLY, token.SLASH:
			return arithmeticOp(vm, left, right, expr.Operator)

		case token.LESS, token.LESS_OR_EQUAL, token.GREATER_OR_EQUAL, token.GREATER:
			var a, b JSValue
			a, err = vm.coerceToPrimitive(left, PrimCoerceValueOfFirst)
			if err != nil {
				return nil, err
			}
			b, err = vm.coerceToPrimitive(right, PrimCoerceValueOfFirst)
			if err != nil {
				return nil, err
			}

			var bval bool
			switch expr.Operator {
			case token.LESS:
				bval, err = isLessThan(vm, a, b)
			case token.LESS_OR_EQUAL:
				bval, err = isNotLessThan(vm, b, a)
			case token.GREATER_OR_EQUAL:
				bval, err = isNotLessThan(vm, a, b)
			case token.GREATER:
				bval, err = isLessThan(vm, b, a)
			default:
				panic("unreachable")
			}

			value = JSBoolean(bval)
			return

		case token.LOGICAL_OR:
			var a, b JSValue
			a, err = vm.evalExpr(expr.Left)
			if err != nil {
				return nil, err
			}
			aBool := vm.coerceToBoolean(a)
			if aBool {
				// return the value itself!
				return a, nil
			}
			b, err = vm.evalExpr(expr.Right)
			if err != nil {
				return nil, err
			}
			return b, nil

		case token.LOGICAL_AND:
			var a, b JSValue
			a, err = vm.evalExpr(expr.Left)
			if err != nil {
				return nil, err
			}
			aBool := vm.coerceToBoolean(a)
			if !aBool {
				// return the value itself!
				return a, nil
			}
			b, err = vm.evalExpr(expr.Right)
			if err != nil {
				return nil, err
			}
			// return the value itself!
			return b, nil

		case token.INSTANCEOF:
			var obj, constructor, soughtProto *JSObject
			var protoValue JSValue

			obj, err = vm.coerceToObject(left)
			if err == nil {
				constructor, err = vm.coerceToObject(right)
			}
			if err == nil {
				protoValue, err = constructor.GetProperty(NameStr("prototype"), vm)
			}
			if err == nil {
				soughtProto, err = vm.coerceToObject(protoValue)
			}
			if err == nil {
				isInstance := false
				for ; obj != nil; obj = obj.Prototype {
					if obj == soughtProto {
						isInstance = true
						break
					}
				}
				return JSBoolean(isInstance), nil
			}
			return nil, err

		default:
			return nil, fmt.Errorf("unsupported binary operator: %s", expr.Operator)
		}

	case *ast.DotExpression:
		var left JSValue
		var obj *JSObject

		left, err = vm.evalExpr(expr.Left)
		if err == nil {
			obj, err = vm.coerceToObject(left)
		}
		if err == nil {
			value, err = obj.GetProperty(NameStr(expr.Identifier.Name), vm)
		}
		return

	case *ast.CallExpression:
		var calleeObj *JSObject
		var subject JSValue = JSUndefined{}

		if calleeDot, isDot := expr.Callee.(*ast.DotExpression); isDot {
			subject, err = vm.evalExpr(calleeDot.Left)
			if err != nil {
				return nil, fmt.Errorf("evaluating method call subject: %w", err)
			}
			subjectObj, err := vm.coerceToObject(subject)
			if err != nil {
				return nil, fmt.Errorf("in method call subject, coercing to object: %w", err)
			}
			method, err := subjectObj.GetProperty(NameStr(calleeDot.Identifier.Name), vm)
			if err != nil {
				return nil, fmt.Errorf("in method call, evaluating method %s: %w", calleeDot.Identifier.Name, err)
			}
			calleeObj, err = vm.coerceToObject(method)
			if err != nil {
				return nil, fmt.Errorf("in method call, coercing method %s to object: %w", calleeDot.Identifier.Name, err)
			}

		} else {
			callee, err := vm.evalExpr(expr.Callee)
			if err != nil {
				return nil, fmt.Errorf("evaluating callee %v: %w", expr.Callee, err)
			}
			calleeObj, err = vm.coerceToObject(callee)
			if err != nil {
				return nil, fmt.Errorf("coercing callee to object %v: %w", expr.Callee, err)
			}
		}

		args := make([]JSValue, len(expr.ArgumentList))
		for i, arg := range expr.ArgumentList {
			args[i], err = vm.evalExpr(arg)
			if err != nil {
				return nil, err
			}
		}

		return calleeObj.Invoke(vm, subject, args, CallFlags{})

	case *ast.UnaryExpression:
		switch expr.Operator {
		case token.DELETE:
			if expr.Postfix {
				panic("delete must be prefix")
			}
			switch operand := expr.Operand.(type) {
			case *ast.Identifier:
				didDelete := vm.curScope.env.deleteVar(vm.curScope, NameStr(operand.Name))
				value = JSBoolean(didDelete)
				return

			case *ast.DotExpression:
				var objVal JSValue
				var obj *JSObject
				objVal, err = vm.evalExpr(operand.Left)
				if err == nil {
					obj, err = vm.coerceToObject(objVal)
				}
				if err == nil {
					didDelete := obj.DeleteProperty(NameStr(operand.Identifier.Name))
					value = JSBoolean(didDelete)
				}
				return
			default:
				msg := fmt.Sprintf("unsupported/invalid delete argument: %v", expr.Operand)
				return nil, vm.ThrowError("SyntaxError", msg)
			}

		case token.TYPEOF:
			arg, err := vm.evalExpr(expr.Operand)
			if err != nil {
				return nil, err
			}
			switch arg.Category() {
			case VObject, VNull:
				return JSString("object"), nil
			case VBigInt:
				return JSString("bigint"), nil
			case VBoolean:
				return JSString("boolean"), nil
			case VFunction:
				return JSString("function"), nil
			case VNumber:
				return JSString("number"), nil
			case VString:
				return JSString("string"), nil
			case VUndefined:
				return JSString("undefined"), nil
			default:
				panic("unexpected modeledjs.JSVCategory")
			}

		case token.NOT:
			arg, err := vm.evalExpr(expr.Operand)
			if err != nil {
				return nil, err
			}
			isTruthy := vm.coerceToBoolean(arg)
			return JSBoolean(!isTruthy), nil

		case token.PLUS:
			arg, err := vm.evalExpr(expr.Operand)
			if err != nil {
				return nil, err
			}
			return vm.coerceNumeric(arg)

		case token.MINUS:
			arg, err := vm.evalExpr(expr.Operand)
			if err != nil {
				return nil, err
			}
			num, err := vm.coerceNumeric(arg)
			if err != nil {
				return nil, err
			}
			switch spec := num.(type) {
			case JSNumber:
				return JSNumber(-spec), nil
			case JSBigInt:
				return JSBigInt(-spec), nil
			default:
				panic("bug: coerceNumeric returned something other than number or bigint")
			}

		case token.VOID:
			// evaluate and discard
			_, err = vm.evalExpr(expr.Operand)
			value = JSUndefined{}
			return

		default:
			return nil, vm.ThrowError("SyntaxError", "unsupported unary expression: "+expr.Operator.String())
		}

	case *ast.BracketExpression:
		left, err := vm.evalExpr(expr.Left)
		if err != nil {
			return nil, err
		}

		leftObj, err := vm.coerceToObject(left)
		if err != nil {
			return nil, err
		}

		member, err := vm.evalExpr(expr.Member)
		if err != nil {
			return nil, err
		}

		switch key := member.(type) {
		case JSNumber:
			index := uint(key)
			return leftObj.GetIndex(index)
		case JSBigInt:
			index := uint(key)
			return leftObj.GetIndex(index)
		case JSString:
			return leftObj.GetProperty(NameStr(string(key)), vm)
		default:
			msg := fmt.Sprintf("invalid type for object key: %s", reflect.TypeOf(member).String())
			return nil, vm.ThrowError("TypeError", msg)
		}

	case *ast.ConditionalExpression:
		test, err := vm.evalExpr(expr.Test)
		if err != nil {
			return nil, err
		}

		if vm.coerceToBoolean(test) {
			value, err = vm.evalExpr(expr.Consequent)
		} else {
			value, err = vm.evalExpr(expr.Alternate)
		}
		return value, err

	case *ast.EmptyExpression:
		return JSUndefined{}, nil

	case *ast.NewExpression:
		cons, err := vm.evalExpr(expr.Callee)
		if err != nil {
			return nil, err
		}

		consObj, err := vm.coerceToObject(cons)
		if err != nil {
			return nil, err
		}

		args := make([]JSValue, len(expr.ArgumentList))
		for i, argExpr := range expr.ArgumentList {
			args[i], err = vm.evalExpr(argExpr)
			if err != nil {
				return nil, err
			}
		}

		initObj := NewJSObject(&ProtoObject)
		value, err = consObj.Invoke(vm, &initObj, args, CallFlags{isNew: true})
		if err != nil {
			return nil, err
		}

		if _, isUnd := value.(JSUndefined); isUnd {
			value = &initObj
		}
		return value, nil

	case *ast.SequenceExpression:
		for _, item := range expr.Sequence {
			value, err = vm.evalExpr(item)
			if err != nil {
				break
			}
		}
		return

	case *ast.ThisExpression:
		var scope *Scope = currentCall(vm.curScope)
		if scope == nil {
			return &vm.globalObject, nil
		}
		return scope.call.this, nil

	case *ast.VariableExpression:
		if expr.Initializer == nil {
			value = JSUndefined{}
		} else {
			value, err = vm.evalExpr(expr.Initializer)
		}
		if err == nil {
			vm.curScope.env.defineVar(vm.curScope, DeclVar, NameStr(expr.Name), value)
		}
		return value, nil

	case *ast.Identifier:
		// some well-known identifiers directly resolve to a value without any lookup
		if expr.Name == "undefined" {
			return JSUndefined{}, nil
		}

		value, found := vm.curScope.env.lookupVar(vm.curScope, NameStr(expr.Name))
		if !found {
			msg := fmt.Sprintf("undefined variable: %s", expr.Name)
			err = vm.ThrowError("NameError", msg)
		}
		return value, err

	case *ast.BooleanLiteral:
		return JSBoolean(expr.Value), nil
	case *ast.NullLiteral:
		return JSNull{}, nil
	case *ast.NumberLiteral:
		switch spec := expr.Value.(type) {
		case float64:
			return JSNumber(spec), nil
		case int64:
			return JSBigInt(spec), nil
		default:
			panic(fmt.Sprintf("invalid number literal value: %#v", expr.Value))
		}

	case *ast.StringLiteral:
		return JSString(expr.Value), nil

	// case *ast.RegExpLiteral:

	default:
		// includes *ast.BadExpression
		msg := fmt.Sprintf("unsupported expression node: %#v", expr)
		return nil, vm.ThrowError("SyntaxError", msg)
	}
}

func currentCall(scope *Scope) *Scope {
	for ; scope != nil; scope = scope.parent {
		if scope.call != nil {
			return scope
		}
	}
	return scope
}

func addition(vm *VM, left, right JSValue) (res JSValue, err error) {
	/*
		    a. Let lprim be ? ToPrimitive(lval).
			b. Let rprim be ? ToPrimitive(rval).
			c. If lprim is a String or rprim is a String, then
				i. Let lstr be ? ToString(lprim).
				ii. Let rstr be ? ToString(rprim).
				iii. Return the string-concatenation of lstr and rstr.
			d. Set lval to lprim.
			e. Set rval to rprim.
	*/
	lprim, err := vm.coerceToPrimitive(left, PrimCoerceValueOfFirst)
	if err != nil {
		return
	}

	rprim, err := vm.coerceToPrimitive(right, PrimCoerceValueOfFirst)
	if err != nil {
		return
	}

	_, isLStr := lprim.(JSString)
	_, isRStr := rprim.(JSString)
	if isLStr || isRStr {
		var lstr, rstr JSString
		lstr, err = vm.coerceToString(lprim)
		if err != nil {
			return
		}

		rstr, err = vm.coerceToString(rprim)
		if err != nil {
			return
		}

		return lstr + rstr, nil
	}

	return arithmeticOp(vm, lprim, rprim, token.PLUS)
}

func arithmeticOp(vm *VM, l, r JSValue, op token.Token) (res JSValue, err error) {
	/*
		3. Let lnum be ? ToNumeric(lval).
		4. Let rnum be ? ToNumeric(rval).
		5. If Type(lnum) is not Type(rnum), throw a TypeError exception.
		6. If lnum is a BigInt, then

			a. If opText is **, return ? BigInt::exponentiate(lnum, rnum).
			b. If opText is /, return ? BigInt::divide(lnum, rnum).
			c. If opText is %, return ? BigInt::remainder(lnum, rnum).
			d. If opText is >>>, return ? BigInt::unsignedRightShift(lnum, rnum).

		7. Let operation be the abstract operation associated with opText and Type(lnum) in the following table:
	*/

	var lin, rin JSValue

	lin, err = vm.coerceNumeric(l)
	if err != nil {
		return JSNumber(math.NaN()), nil
	}

	rin, err = vm.coerceNumeric(r)
	if err != nil {
		return JSNumber(math.NaN()), nil
	}

	if lin.Category() != rin.Category() {
		err = vm.ThrowError("TypeError", "arithmetic is invalid for types number/bigint or bigint/number")
		return
	}

	if li, isBigInt := lin.(JSBigInt); isBigInt {
		ri, isRBI := rin.(JSBigInt)
		if !isRBI {
			panic("bug: rhs value in arithmetic must be bigint here")
		}
		switch op {
		// TODO: operator `**`
		case token.MULTIPLY:
			return li * ri, nil
		case token.PLUS:
			return li + ri, nil
		case token.MINUS:
			return li - ri, nil
		case token.SHIFT_LEFT:
			return li << ri, nil
		case token.SHIFT_RIGHT:
			return li >> ri, nil
		case token.EXCLUSIVE_OR:
			return li ^ ri, nil
		case token.AND:
			return li & ri, nil
		case token.OR:
			return li | ri, nil
		case token.SLASH:
			if ri == 0 {
				return JSNumber(math.Inf(+1)), nil
			}
			return li / ri, nil
		case token.REMAINDER:
			return li % ri, nil
		case token.UNSIGNED_SHIFT_RIGHT:
			return li >> ri, nil
		default:
			err = vm.ThrowError("SyntaxError", "unsupported/invalid arithmetic operator: "+op.String())
			return
		}
	} else if ln, isNum := lin.(JSNumber); isNum {
		rn, isRNum := rin.(JSNumber)
		if !isRNum {
			panic("bug: rhs value in arithmetic must be bigint here")
		}

		switch op {
		// TODO operator `**` (exponentiate)
		case token.MULTIPLY:
			return ln * rn, nil
		case token.SLASH:
			return ln / rn, nil
		case token.REMAINDER:
			return JSNumber(floatRemainder(float64(ln), float64(rn))), nil
		case token.PLUS:
			return ln + rn, nil
		case token.MINUS:
			return ln - rn, nil
		case token.SHIFT_LEFT:
			return JSNumber(int32(ln) << int32(rn)), nil
		case token.SHIFT_RIGHT:
			return JSNumber(int32(ln) >> int32(rn)), nil
		case token.UNSIGNED_SHIFT_RIGHT:
			return JSNumber(int32(ln) >> int32(rn)), nil
		case token.AND:
			return JSNumber(int32(ln) & int32(rn)), nil
		case token.OR:
			return JSNumber(int32(ln) | int32(rn)), nil
		case token.EXCLUSIVE_OR:
			return JSNumber(int32(ln) ^ int32(rn)), nil
		default:
			err = vm.ThrowError("SyntaxError", "unsupported/invalid arithmetic operator: "+op.String())
			return
		}

	} else {
		panic("bug: coerceNumeric returned something other than number or bigint")
	}

}

func floatRemainder(n, d float64) float64 {
	// 1. If n is NaN or d is NaN, return NaN.
	if math.IsNaN(n) || math.IsNaN(d) {
		return math.NaN()
	}

	// 2. If n is either +∞𝔽 or -∞𝔽, return NaN.
	if math.IsInf(n, 0) {
		return math.NaN()
	}

	// 3. If d is either +∞𝔽 or -∞𝔽, return n.
	if math.IsInf(d, 0) {
		return n
	}

	// 4. If d is either +0𝔽 or -0𝔽, return NaN.
	if d == 0.0 || d == math.Copysign(0, -1) {
		return math.NaN()
	}

	// 5. If n is either +0𝔽 or -0𝔽, return n.
	if n == 0.0 || n == math.Copysign(0, -1) {
		return n
	}

	// 6. Assert: n and d are finite and non-zero.
	// 7. Let quotient be ℝ(n) / ℝ(d).
	// 8. Let q be truncate(quotient).
	// 9. Let r be ℝ(n) - (ℝ(d) × q).
	quotient := n / d
	q := math.Trunc(quotient)
	r := n - (d * q)

	// 10. If r = 0 and n < -0𝔽, return -0𝔽.
	if r == 0 && n < math.Copysign(0, -1) {
		return math.Copysign(0, -1)
	}

	// 11. Return 𝔽(r).
	return r
}

func doAssignment(vm *VM, target ast.Expression, value JSValue) error {
	switch target := target.(type) {
	case *ast.Identifier:
		return vm.curScope.env.setVar(vm.curScope, NameStr(target.Name), value, vm)

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

	case *JSObject:
		return specific, nil

	default:
		// includes null, undefined
		msg := fmt.Sprintf("can't convert to object: %#v", value)
		err = vm.ThrowError("TypeError", msg)
		return nil, err
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

func (vm *VM) strictEqual(left, right JSValue) bool {
	switch leftV := left.(type) {
	case JSBigInt:
		rightV, isSame := right.(JSBigInt)
		if !isSame {
			return false
		}
		return leftV == rightV
	case JSBoolean:
		rightV, isSame := right.(JSBoolean)
		if !isSame {
			return false
		}
		return leftV == rightV
	case JSNumber:
		rightV, isSame := right.(JSNumber)
		if !isSame {
			return false
		}
		return leftV == rightV
	case *JSObject:
		rightV, isSame := right.(*JSObject)
		if !isSame {
			return false
		}
		return leftV == rightV
	case JSString:
		rightV, isSame := right.(JSString)
		if !isSame {
			return false
		}
		return leftV == rightV

	case JSNull:
		_, isSame := right.(JSNull)
		return isSame
	case JSUndefined:
		_, isSame := right.(JSUndefined)
		return isSame

	default:
		panic(fmt.Sprintf("unexpected value for strict equal comparison: %#v", left))
	}
}

func (vm *VM) looseEqual(a, b JSValue) (ret bool, err error) {
	aOrig := a
	bOrig := b
	/*
		If the operands have the same type, they are compared as follows:
			Object: return true only if both operands reference the same object.
			String: return true only if both operands have the same characters in the same order.
			Number: return true only if both operands have the same value. +0 and -0 are treated as the same value. If either operand is NaN, return false; so, NaN is never equal to NaN.
			Boolean: return true only if operands are both true or both false.
			BigInt: return true only if both operands have the same value.
			Symbol: return true only if both operands reference the same symbol.
		If one of the operands is null or undefined, the other must also be null or undefined to return true. Otherwise return false.
		If one of the operands is an object and the other is a primitive, convert the object to a primitive.
		At this step, both operands are converted to primitives (one of String, Number, Boolean, Symbol, and BigInt). The rest of the conversion is done case-by-case.
			If they are of the same type, compare them using step 1.
			If one of the operands is a Symbol but the other is not, return false.
			If one of the operands is a Boolean but the other is not, convert the boolean to a number: true is converted to 1, and false is converted to 0. Then compare the two operands loosely again.
			Number to String: convert the string to a number. Conversion failure results in NaN, which will guarantee the equality to be false.
			Number to BigInt: compare by their numeric value. If the number is ±Infinity or NaN, return false.
			String to BigInt: convert the string to a BigInt using the same algorithm as the BigInt() constructor. If conversion fails, return false.
	*/

	for counter := 0; counter < 5; counter++ {
		if err != nil {
			return
		}

		if a.Category() == b.Category() {
			// same type
			ret = vm.strictEqual(a, b)
			return
		}

		_, isAU := a.(JSUndefined)
		_, isAN := a.(JSNull)
		_, isBU := b.(JSUndefined)
		_, isBN := b.(JSNull)
		if isAU || isAN || isBU || isBN {
			ret = (isAU || isAN) && (isBU || isBN)
			return
		}

		_, isAObj := a.(*JSObject)
		_, isBObj := b.(*JSObject)
		if isAObj {
			if isBObj {
				panic("inconsistent value type")
			}
			a, err = vm.coerceToPrimitive(a, PrimCoerceValueOfFirst)
			continue
		}
		if isBObj {
			if isAObj {
				panic("inconsistent value type")
			}
			b, err = vm.coerceToPrimitive(b, PrimCoerceValueOfFirst)
			continue
		}

		// TODO Check for Symbol here

		// If one of the operands is a Boolean but the other is not,
		// convert the boolean to a number: true is converted to 1, and
		// false is converted to 0. Then compare the two operands
		// loosely again.
		aBool, isABool := a.(JSBoolean)
		bBool, isBBool := b.(JSBoolean)
		if isABool {
			if aBool {
				a = JSNumber(1.0)
			} else {
				a = JSNumber(0.0)
			}
			continue
		}
		if isBBool {
			if bBool {
				b = JSNumber(1.0)
			} else {
				b = JSNumber(0.0)
			}
			continue
		}

		_, isAStr := a.(JSString)
		_, isBStr := b.(JSString)
		_, isANum := a.(JSNumber)
		_, isBNum := b.(JSNumber)
		if isAStr && isBNum {
			a, err = vm.coerceToNumber(a)
			continue
		}
		if isANum && isBStr {
			b, err = vm.coerceToNumber(b)
			continue
		}

		if isAStr && isBNum {
			a, err = vm.coerceToNumber(a)
			if err != nil {
				return false, nil
			}
			continue
		}
		if isANum && isBStr {
			b, err = vm.coerceToNumber(b)
			if err != nil {
				return false, nil
			}
			continue
		}

		ai, isABigInt := a.(JSBigInt)
		bi, isBBigInt := b.(JSBigInt)
		if isAStr && isBBigInt {
			a, err = vm.coerceToBigInt(a)
			continue
		}
		if isABigInt && isBStr {
			b, err = vm.coerceToBigInt(b)
			continue
		}

		if isANum && isBBigInt {
			b = JSNumber(float64(int64(bi)))
			continue
		}
		if isABigInt && isBNum {
			a = JSNumber(float64(int64(ai)))
			continue
		}

		msg := fmt.Sprintf("unreachable! looseEqual called with %s (->%s) / %s (->%s)",
			reflect.TypeOf(aOrig),
			reflect.TypeOf(a),
			reflect.TypeOf(bOrig),
			reflect.TypeOf(b),
		)
		panic(msg)
	}

	panic("bug: looseEqual iterated too many times!")
}

func (vm *VM) coerceNumeric(value JSValue) (num JSValue, err error) {
	num, err = vm.coerceToPrimitive(value, PrimCoerceValueOfFirst)
	if err != nil {
		return
	}

	if _, isBigInt := num.(JSBigInt); !isBigInt {
		num, err = vm.coerceToNumber(num)
	}
	return
}

func (vm *VM) coerceToNumber(value JSValue) (num JSNumber, err error) {
	/*
		Numbers are returned as-is.
		undefined turns into NaN.
		null turns into 0.
		true turns into 1; false turns into 0.
		Strings are converted by parsing them as if they contain a number literal.
		Parsing failure results in NaN. There are some minor differences compared to an actual number literal:
			Leading and trailing whitespace/line terminators are ignored. A leading
			0 digit does not cause the number to become an octal literal (or get
			rejected in strict mode). + and - are allowed at the start of the string
			to indicate its sign. (In actual code, they "look like" part of the
			literal, but are actually separate unary operators.) However, the sign
			can only appear once, and must not be followed by whitespace. Infinity
			and -Infinity are recognized as literals. In actual code, they are
			global variables. Empty or whitespace-only strings are converted to 0.
			Numeric separators are not allowed.
		BigInts throw a TypeError to prevent unintended implicit coercion causing loss of precision.
		Symbols throw a TypeError.
		Objects are first converted to a primitive by calling their [Symbol.toPrimitive]() (with "number" as hint), valueOf(), and toString() methods, in that order. The resulting primitive is then converted to a number.
	*/

	switch spec := value.(type) {
	case JSNull:
		num = 0
	case JSBigInt:
		num = JSNumber(float64(int64(spec)))
	case JSBoolean:
		if spec {
			num = JSNumber(1.0)
		} else {
			num = JSNumber(0.0)
		}

	case JSNumber:
		break

	case *JSObject:
		var prim JSValue
		prim, err = vm.coerceToPrimitive(value, PrimCoerceValueOfFirst)
		if err == nil {
			num, err = vm.coerceToNumber(prim)
		}

	case JSString:
		var numF64 float64
		numF64, err = strconv.ParseFloat(string(spec), 64)
		if err != nil {
			err = vm.ThrowError("SyntaxError", err.Error())
		}
		num = JSNumber(numF64)

	case JSUndefined:
		num = JSNumber(math.NaN())

	default:
		panic(fmt.Sprintf("unexpected modeledjs.JSValue: %#v", spec))
	}

	return
}

type PrimCoerceOrder uint8

const (
	PrimCoerceValueOfFirst PrimCoerceOrder = iota
	PrimCoerceToStringFirst
)

func (vm *VM) coerceToPrimitive(value JSValue, order PrimCoerceOrder) (prim JSValue, err error) {
	switch spec := value.(type) {
	case *JSObject:
		// valToPrimitive, err := vm.globalObject.GetProperty(NameStr("Symbol"), vm)
		// if err != nil {
		// 	return nil, err
		// }
		// symToPrimitive, isSym := valToPrimitive.(JSSymbol)

		var callOrder []string
		switch order {
		case PrimCoerceValueOfFirst:
			callOrder = []string{"toString", "valueOf"}
		case PrimCoerceToStringFirst:
			callOrder = []string{"valueOf", "toString"}
		default:
			return nil, fmt.Errorf("invalid order (only allowed are PrimCoerceToStringFirst, PrimCoerceValueOfFirst)")
		}

		for _, methodName := range callOrder {
			methodVal, err := spec.GetProperty(NameStr(methodName), vm)
			if err != nil {
				return nil, err
			}
			methodObj, isObj := methodVal.(*JSObject)
			if !isObj || methodObj.funcPart == nil {
				continue
			}

			ret, err := methodObj.Invoke(vm, value, []JSValue{}, CallFlags{})
			if err != nil {
				return nil, err
			}
			switch ret := ret.(type) {
			case *JSObject:
			case JSUndefined:
				continue
			default:
				// primitive
				return ret, nil
			}
		}
		return nil, vm.ThrowError("TypeError", "value can't be converted to a primitive")

	default:
		return value, nil
	}

}

func (vm *VM) coerceToString(val JSValue) (ret JSString, err error) {
	switch val := val.(type) {
	case JSString:
		return val, nil
	// TODO case JSSymbol
	case JSUndefined:
		return "undefined", nil
	case JSNull:
		return "null", nil
	case JSBoolean:
		if val {
			return "true", nil
		} else {
			return "false", nil
		}
	case JSNumber:
		s := fmt.Sprintf("%f", float64(val))
		return JSString(s), nil
	case JSBigInt:
		s := fmt.Sprintf("%d", int64(val))
		return JSString(s), nil
	case *JSObject:
		prim, err := vm.coerceToPrimitive(val, PrimCoerceToStringFirst)
		if err != nil {
			return "", err
		}
		if _, isObj := prim.(*JSObject); isObj {
			panic("bug: coerceToPrimitive returned object")
		}
		return vm.coerceToString(prim)

	default:
		panic("bug: invalid type for coerceToString operand: " + reflect.TypeOf(val).String())
	}
}

func (vm *VM) coerceToBigInt(value JSValue) (ret JSBigInt, err error) {
	if _, isObj := value.(*JSObject); isObj {
		value, err = vm.coerceToPrimitive(value, PrimCoerceValueOfFirst)
		if err != nil {
			return
		}
	}

	switch spec := value.(type) {
	case JSBigInt:
		ret = spec
	case JSNumber:
		ret = JSBigInt(int64(spec))
	case JSBoolean:
		if spec {
			ret = 1
		} else {
			ret = 0
		}
	case JSString:
		retI64, err := strconv.ParseInt(string(spec), 10, 64)
		if err == nil {
			ret = JSBigInt(retI64)
		}

	case JSNull:
	case JSUndefined:
		// case JSSymbol:
		err = vm.ThrowError("TypeError", "can't convert to BigInt from null, undefined or symbol")

	default:
		panic(fmt.Sprintf("unexpected modeledjs.JSValue: %#v", value))
	}

	return
}

type tribool uint8

const (
	TFalse tribool = iota
	TTrue
	TNeither
)

func bool2tri(b bool) tribool {
	if b {
		return TTrue
	} else {
		return TFalse
	}
}

func compareLessThan(vm *VM, a, b JSValue) (ret tribool, err error) {
	_, isAObj := a.(*JSObject)
	_, isBObj := b.(*JSObject)
	if isAObj {
		return TNeither, fmt.Errorf("a must be primitive")
	}
	if isBObj {
		return TNeither, fmt.Errorf("b must be primitive")
	}

	if aStr, isAStr := a.(JSString); isAStr {
		if bStr, isBStr := b.(JSString); isBStr {
			al := len(aStr)
			bl := len(bStr)

			limit := min(al, bl)
			for i := 0; i < limit; i++ {
				ac := aStr[i]
				bc := bStr[i]
				if ac < bc {
					return TTrue, nil
				}
				if ac > bc {
					return TFalse, nil
				}
			}
			if al < bl {
				return TTrue, nil
			}
			return TFalse, nil
		} else if bBI, isBBigInt := b.(JSBigInt); isBBigInt {
			aBI, err := strconv.ParseInt(string(aStr), 10, 64)
			if err != nil {
				return TNeither, nil
			}
			return bool2tri(aBI < int64(bBI)), nil
		}
	} else if aBI, isABigInt := a.(JSBigInt); isABigInt {
		if bStr, isBStr := b.(JSString); isBStr {
			bBI, err := strconv.ParseInt(string(bStr), 10, 64)
			if err != nil {
				return TNeither, nil
			}
			return bool2tri(int64(aBI) < bBI), nil
		}
	}

	// numeric comparison
	abn, err := vm.coerceNumeric(a)
	if err != nil {
		return TNeither, err
	}
	bbn, err := vm.coerceNumeric(b)
	if err != nil {
		return TNeither, err
	}

	an, isANum := abn.(JSNumber)
	bn, isBNum := bbn.(JSNumber)
	ai, isABigInt := abn.(JSBigInt)
	bi, isBBigInt := bbn.(JSBigInt)

	if isANum {
		if math.IsNaN(float64(an)) {
			return TNeither, nil
		} else if math.IsInf(float64(an), -1) {
			return TTrue, nil
		} else if math.IsInf(float64(an), +1) {
			return TFalse, nil
		}
	}
	if isBNum {
		if math.IsNaN(float64(bn)) {
			return TNeither, nil
		} else if math.IsInf(float64(bn), -1) {
			return TFalse, nil
		} else if math.IsInf(float64(bn), +1) {
			return TTrue, nil
		}
	}

	if isANum {
		if isBNum {
			return bool2tri(an < bn), nil
		} else if isBBigInt {
			// replacing a with floor(a) does not influence the comparison
			aFloor := int64(math.Floor(float64(an)))
			return bool2tri(aFloor < int64(bi)), nil
		} else {
			panic("bug: invalid type b from coerceNumeric")
		}
	} else if isABigInt {
		if isBNum {
			// replacing b with ceil(b) does not influence the comparison
			bCeil := int64(math.Ceil(float64(bn)))
			return bool2tri(int64(ai) < bCeil), nil
		} else if isBBigInt {
			return bool2tri(ai < bi), nil
		} else {
			panic("bug: invalid type b from coerceNumeric")
		}
	} else {
		panic("bug: invalid type a from coerceNumeric")
	}
}

func isLessThan(vm *VM, a, b JSValue) (ret bool, err error) {
	tri, err := compareLessThan(vm, a, b)
	if err != nil {
		return false, err
	}
	switch tri {
	case TFalse, TNeither:
		return false, nil
	case TTrue:
		return true, nil
	default:
		panic(fmt.Sprintf("unexpected modeledjs.tribool: %#v", tri))
	}
}

func isNotLessThan(vm *VM, a, b JSValue) (ret bool, err error) {
	tri, err := compareLessThan(vm, a, b)
	if err != nil {
		return false, err
	}
	switch tri {
	// note that TNeither always results in false, even with negation
	case TTrue, TNeither:
		return false, nil
	case TFalse:
		return true, nil
	default:
		panic(fmt.Sprintf("unexpected modeledjs.tribool: %#v", tri))
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

func fixAndCheck(file *parserFile.File, node ast.Node) error {
	chk := &checker{
		file: file,
	}
	ast.Walk(chk, node)
	if len(chk.errs) > 0 {
		return multiSyntaxErrors(chk.errs)
	}
	return nil
}

type checker struct {
	file *parserFile.File
	errs []error
	ctx  []checkerContext
}
type checkerContext struct {
	node      ast.Node
	setStrict bool
}

type multiSyntaxErrors []error

func (mserr multiSyntaxErrors) Error() string {
	switch len(mserr) {
	case 0:
		return "no syntax errors"
	case 1:
		return mserr[0].Error()
	default:
		lines := make([]string, 1+len(mserr))
		lines[0] = fmt.Sprintf("%d syntax errors:", len(mserr))
		for i, err := range mserr {
			lines[i] = fmt.Sprintf("%3d. %s", i+1, err.Error())
		}
		return strings.Join(lines, "\n")
	}
}

func (c *checker) setStrict() {
	cl := len(c.ctx)
	for i := 0; i < cl; i++ {
		ctx := &c.ctx[cl-1-i]

		_, isFuncLit := ctx.node.(*ast.FunctionLiteral)
		_, isProgram := ctx.node.(*ast.Program)

		if isFuncLit || isProgram {
			ctx.setStrict = true
			break
		}
	}
}

func (c *checker) isStrictHere() bool {
	cl := len(c.ctx)
	for i := 0; i < cl; i++ {
		item := c.ctx[cl-1-i]
		if item.setStrict {
			return true
		}
	}
	return false
}

func (c *checker) emitErr(msg string) {
	var err error

	node := c.ctx[len(c.ctx)-1].node
	if c.file == nil {
		err = fmt.Errorf("?:?: %s", msg)
	} else {
		idx := node.Idx0()
		pos := c.file.Position(idx)
		err = fmt.Errorf("%s: %s", pos, msg)
	}

	c.errs = append(c.errs, err)
}

func (c *checker) Enter(node ast.Node) (v ast.Visitor) {
	c.ctx = append(c.ctx, checkerContext{
		node:      node,
		setStrict: false,
	})

	switch node := node.(type) {
	case *ast.Program:
		// NOTE This avoids a corner case that is not correctly managed by the parser library
		// program.Idx0() would panic
		if len(node.Body) == 0 {
			node.Body = []ast.Statement{
				&ast.EmptyStatement{},
			}
		}

	case *ast.StringLiteral:
		if node.Value == "use strict" {
			c.setStrict()
		}

	case *ast.VariableExpression:
		if c.isStrictHere() && isStrictReservedKw(node.Name) {
			c.emitErr(fmt.Sprintf("variable can't be named %s in strict mode (it's a reserved keyword)", node.Name))
		}

	case *ast.WithStatement:
		if c.isStrictHere() {
			c.emitErr("with statement can't appear in strict mode")
		}

	case *ast.ForStatement:
		c.forbidFuncDecl(node.Body)
	case *ast.ForInStatement:
		c.forbidFuncDecl(node.Body)
	case *ast.WhileStatement:
		c.forbidFuncDecl(node.Body)
	case *ast.DoWhileStatement:
		c.forbidFuncDecl(node.Body)
	}

	// keep using the same visitor
	return c
}

func (c *checker) forbidFuncDecl(node ast.Node) {
	_, isFnDecl := node.(*ast.FunctionLiteral)
	_, isFnStmt := node.(*ast.FunctionStatement)
	if isFnDecl || isFnStmt {
		c.emitErr("function declaration cannot appear in statement position")
	}
}

var strictReservedKw = []string{
	"implements",
	"let",
	"private",
	"public",
	"interface",
	"package",
	"protected",
	"static",
	"yield",
}

// Returns true iff the given string corresponds to a keyword that is reserved in strict mode only.
func isStrictReservedKw(s string) bool {
	for _, kw := range strictReservedKw {
		if kw == s {
			return true
		}
	}
	return false
}

func (c *checker) Exit(node ast.Node) {
	if c.ctx[len(c.ctx)-1].node != node {
		panic("bug: fixAndCheck: inconsistent context")
	}

	c.ctx = c.ctx[:len(c.ctx)-1]
}
