import * as acorn from "npm:acorn";
import * as acornWalk from "npm:acorn-walk";

// overview of the plan:
//
//  - impl 1: as a naive ast interpreter, validated against test262
//      - vm state includes stack and heap
//      - stack identifies variable by names
//  - impl 2: bytecode interpreter, with coarse instructions

class AssertionError extends Error {}
function assert(
	value: boolean,
	msg: string | (() => string),
): asserts value {
	if (!value) {
		// note that if msg is a function, we only call it when we know the assertion is failed.
		if (typeof msg === "function") {
			msg = msg();
		}
		throw new AssertionError("assertion failed: " + msg);
	}
}

// deno-fmt-ignore
// deno-lint-ignore no-explicit-any
function assertIsValue(t: { type: string; value?: any }): asserts t is JSValue {
	let cond: boolean;
	if (t.type === "object")         cond = (t instanceof VMObject);
	else if (t.type === "string")    cond = (typeof t.value === "string");
	else if (t.type === "null")      cond = (t.value === undefined);
	else if (t.type === "undefined") cond = (t.value === undefined);
	else if (t.type === "number")    cond = (typeof t.value === "number");
	else if (t.type === "boolean")   cond = (typeof t.value === "boolean");
	else if (t.type === "bigint")    cond = (typeof t.value === "bigint");
	else if (t.type === "symbol")    cond = (typeof t.value === "symbol");
	else throw new AssertionError("invalid JSValue");

	assert(cond, () => `invalid JSValue (${t.type}): ${Deno.inspect(t)}`);
}

type JSValue =
	| JSPrimitive
	| VMObject;

type JSPrimitive =
	| { type: "null" }
	| { type: "undefined" }
	| { type: "number"; value: number }
	| { type: "boolean"; value: boolean }
	| { type: "string"; value: string }
	| { type: "bigint"; value: bigint }
	| { type: "symbol"; value: symbol };

type PrimType = JSValue["type"];

interface Node extends acorn.Node {
	sourceFile?: string;
}

// Throw an ExceptionRequest instance when a JavaScript exception should be
// thrown, but the current VM instance is not available in the current scope.
//
// If there is a VM "in" the call stack, it will transform the ExceptionRequest
// into a proper JS exception.
class ExceptionRequest extends Error {
	constructor(
		public constructorName: string,
		public message: string,
	) {
		super(message);
	}
}

class ProgramException extends Error {
	context: acorn.Node[];

	constructor(public exceptionValue: JSValue, context: acorn.Node[]) {
		let message: string | undefined;
		if (exceptionValue.type === "string") {
			message = exceptionValue.value;
		} else if (exceptionValue instanceof VMObject) {
			const messageValue = exceptionValue.getProperty("message");
			if (messageValue === undefined) {
				message = "(no message)";
			} else if (messageValue.type === "string") {
				message = messageValue.value;
			}
		}

		super(
			"interpreted js program exception" +
				(message ? `: ${message}` : ""),
		);
		this.exceptionValue = exceptionValue;

		// copy the context.  it's too easy to accidentally assign the mutable context
		// array to this object, which makes it pointless to print later on
		this.context = [...context];
	}
}

type Descriptor = {
	get?: VMInvokable;
	set?: VMInvokable;
	value?: JSValue;
	configurable: boolean;
	enumerable: boolean;
	writable: boolean;
	// when writable and discardWriteSilently are both true, writes are discarded
	// without any error
	discardWriteSilently?: boolean;
};

type PropName = string | symbol;

interface VMRegExp extends VMObject {
	innerRE: RegExp;
}

class VMObject {
	readonly type: "object" | "function" = "object";
	descriptors: Map<PropName, Descriptor> = new Map();

	primitive?: boolean | string | number | bigint | symbol;
	innerRE?: RegExp;

	extensionAllowed: boolean = true;

	constructor(private _proto: VMObject | null = PROTO_OBJECT) {}

	resolveDescriptor(descriptor: Descriptor, vm?: VM) {
		if (descriptor.get !== undefined) {
			assert(vm instanceof VM, "looking up described value but vm not passed");
			return vm.performCall(descriptor.get, this, []);
		}
		assert(
			descriptor.value !== undefined,
			"descriptor does not have getter, must have value",
		);
		return descriptor.value;
	}
	getOwnPropertyDescriptor(name: PropName): Descriptor | undefined {
		return this.descriptors.get(name);
	}
	getOwnPropertyNames(): IterableIterator<PropName> {
		return this.descriptors.keys();
	}
	*getOwnEnumerablePropertyNames(): IterableIterator<PropName> {
		for (const [name, descr] of this.descriptors) {
			if (descr.enumerable) {
				yield name;
			}
		}
	}
	getOwnProperty(name: PropName, vm = undefined): JSValue | undefined {
		const descriptor = this.getOwnPropertyDescriptor(name);
		if (descriptor === undefined) return undefined;

		return this.resolveDescriptor(descriptor, vm);
	}
	containsOwnProperty(name: PropName): boolean {
		return this.descriptors.has(name);
	}
	getProperty(name: PropName, vm?: VM): JSValue | undefined {
		let object: VMObject | null = <VMObject> this;
		let descriptor;
		do {
			descriptor = object.getOwnPropertyDescriptor(name);
			object = object.proto;
		} while (object !== null && descriptor === undefined);

		if (descriptor === undefined) return undefined;

		// found the descriptor in object, but call the descriptor with this
		return this.resolveDescriptor(descriptor, vm);
	}
	setProperty(name: PropName, value: JSValue, vm?: VM) {
		if (name === "__proto__") {
			// call setter
			if (value instanceof VMObject) {
				this.proto = value;
			}
			return;
		}
		const descriptor = this.descriptors.get(name);

		// TODO Honor writable, configurable, etc.
		if (descriptor === undefined) {
			this.defineProperty(name, {
				value,
				configurable: true,
				writable: true,
				enumerable: true,
			});
			return;
		}

		if (!descriptor.writable) {
			if (descriptor.discardWriteSilently) {
				return;
			}
			assert(vm instanceof VM, "looking up described value but vm not passed");
			return vm.throwError("TypeError", "property is not writable");
		}

		if (descriptor.set) {
			assert(vm instanceof VM, "looking up described value but vm not passed");
			return vm.performCall(descriptor.set, this, [value]);
		} else if (descriptor.get === undefined) {
			descriptor.value = value;
		} else {
			assert(vm instanceof VM, "looking up described value but vm not passed");
			// we have a getter but not a setter
			vm.throwError("TypeError", "descriptor has getter but no setter");
		}
	}
	defineProperty(name: PropName, descriptor: Descriptor) {
		// TODO Propertly honor writable, configurable
		if (!this.extensionAllowed) {
			throw new ExceptionRequest(
				"TypeError",
				"can't define new property on non-extensible object",
			);
		}

		this.descriptors.set(name, descriptor);
	}
	deleteProperty(name: PropName): boolean {
		const descriptor = this.descriptors.get(name);
		if (descriptor === undefined || !descriptor.configurable) return false;
		this.descriptors.delete(name);
		return true;
	}

	getIndex(index: number) {
		return this.getOwnProperty(String(index));
	}
	setIndex(index: number, value: JSValue) {
		return this.setProperty(String(index), value);
	}

	get proto(): VMObject | null {
		return this._proto;
	}
	set proto(newProto: VMObject | null) {
		if (!this.extensionAllowed) {
			return;
		}

		assert(
			newProto === null || newProto instanceof VMObject,
			"VMObject's prototype must be VMObject or null",
		);
		this._proto = newProto;
	}

	is(other: JSValue) {
		// we reuse the host JS VM logic for now
		return Object.is(this, other);
	}

	walkPrototypeChain<T>(action: (o: VMObject) => T | null): T | undefined {
		let value, cur: VMObject | null;
		for (cur = this; cur !== null; cur = cur.proto) {
			if ((value = action(cur)) !== null) {
				return value;
			}
		}
	}
}

function assertIsObject(vm: VM, value: JSValue): asserts value is VMObject {
	if (!(value instanceof VMObject)) {
		return vm.throwError("TypeError", "value must be object");
	}
}

class VMArray extends VMObject {
	arrayElements: JSValue[] = [];

	constructor() {
		super(PROTO_ARRAY);

		super.defineProperty("length", {
			get: nativeVMFunc((_vm, subject, _args) => {
				assert(
					subject instanceof VMArray,
					"bug: getter for array property length, but this is not array",
				);
				return { type: "number", value: subject.arrayElements.length };
			}),
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}

	getIndex(index: number) {
		return typeof index === "number"
			? this.arrayElements[index]
			: super.getIndex(index);
	}

	setIndex(index: number, value: JSValue) {
		if (typeof index === "number") this.arrayElements[index] = value;
		else return super.setIndex(index, value);
	}

	*getIndexKeys(): IterableIterator<string> {
		for (let i = 0; i < this.arrayElements.length; ++i) {
			yield String(i);
		}
	}
	override *getOwnPropertyNames(): IterableIterator<PropName> {
		yield* this.getIndexKeys();
		yield* super.getOwnPropertyNames();
	}
	override *getOwnEnumerablePropertyNames(): IterableIterator<PropName> {
		yield* this.getIndexKeys();
		yield* super.getOwnEnumerablePropertyNames();
	}
}

const PROTO_OBJECT = new VMObject(null);
const PROTO_FUNCTION = new VMObject(PROTO_OBJECT);
const PROTO_NUMBER = new VMObject();
const PROTO_BIGINT = new VMObject();
const PROTO_BOOLEAN = new VMObject();
const PROTO_STRING = new VMObject();
const PROTO_SYMBOL = new VMObject();
const PROTO_ARRAY = new VMObject();
const PROTO_REGEXP = new VMObject();

interface InvokeOpts {
	isNew?: boolean;
}

abstract class VMInvokable extends VMObject {
	readonly type = "function";
	isStrict = false;

	params?: string[];
	canConstruct: boolean = false;

	constructor(consPrototype?: VMObject) {
		super(PROTO_FUNCTION);
		if (consPrototype === undefined) {
			consPrototype = new VMObject();
		}
		this.setProperty("prototype", consPrototype);
	}

	abstract run(
		vm: VM,
		subject: JSValue,
		args: JSValue[],
		invokeOpts: InvokeOpts,
	): JSValue;

	invoke(vm: VM, subject: JSValue, args: JSValue[], options: InvokeOpts = {}) {
		// true iff this invocation comes from new Constructor(...)
		const isNew = options.isNew || false;

		if (!isNew) {
			// do this substitution
			if (!this.isStrict) {
				if (subject.type === "undefined" || subject.type === "null") {
					subject = vm.globalObj;
				}
				subject = vm.coerceToObject(subject);
			}
		}

		return vm.withScope(() => {
			assert(vm.currentScope !== null, "no parent scope!");

			vm.currentScope.isNew = isNew;
			vm.currentScope.this = subject;
			assert(
				this.isStrict || subject instanceof VMObject,
				"bug in this-substitution: non strict && this is not object",
			);
			vm.currentScope.isCallWrapper = true;
			vm.currentScope.isSetStrict = this.isStrict;

			// not all subclasses have named params
			if (this.params !== undefined) {
				while (args.length < this.params.length) {
					args.push({ type: "undefined" });
				}

				for (const ndx in this.params) {
					const name = this.params[ndx];
					const value = args[ndx];
					vm.defineVar("var", name, value);
				}
			}

			vm.defineVar("var", "arguments", () => {
				const argumentsArray = new VMArray();
				argumentsArray.arrayElements.push(...args);
				return argumentsArray;
			});

			// another scope, to allow redefinitions
			return vm.withScope(() => this.run(vm, subject, args, options));
		});
	}
}

PROTO_FUNCTION.setProperty(
	"bind",
	nativeVMFunc((vm: VM, outerInvokableValue: JSValue, args: JSValue[]) => {
		const forcedSubject = args[0];
		const outerInvokable = vm.coerceToObject(outerInvokableValue);
		if (outerInvokable instanceof VMInvokable) {
			return nativeVMFunc((vm: VM, _: JSValue, args: JSValue[]) => {
				// force subject to be this inner subject passed here
				return outerInvokable.invoke(vm, forcedSubject, args);
			});
		}

		return vm.throwError(
			"TypeError",
			"Function.prototype.bind: 'this' is not a function",
		);
	}),
);
PROTO_FUNCTION.setProperty(
	"call",
	nativeVMFunc((vm: VM, subject: JSValue, args: JSValue[]) => {
		const forcedSubject: JSValue = args.length >= 1
			? args[0]
			: { type: "undefined" };
		// force subject to be this inner subject passed here
		const outerInvokable = vm.coerceToObject(subject);
		if (!(outerInvokable instanceof VMInvokable)) {
			return vm.throwError(
				"TypeError",
				"Function.prototype.call: 'this' is not a function",
			);
		}
		return outerInvokable.invoke(vm, forcedSubject, args.slice(1));
	}),
);
PROTO_FUNCTION.setProperty(
	"apply",
	nativeVMFunc((vm, subject, args) => {
		const forcedSubject: JSValue = args.length >= 1
			? args[0]
			: { type: "undefined" };

		let argsArray: JSValue[] = [];
		if (args.length >= 2) {
			const arg = args[1];
			if (arg instanceof VMArray) {
				argsArray = arg.arrayElements;
			} else {
				return vm.throwError(
					"TypeError",
					"first argument must be an array (of arguments to pass)",
				);
			}
		}

		// force subject to be this inner subject passed here
		const outerInvokable = vm.coerceToObject(subject);
		if (!(outerInvokable instanceof VMInvokable)) {
			return vm.throwError(
				"TypeError",
				"Function.prototype.call: 'this' is not a function",
			);
		}
		return outerInvokable.invoke(vm, forcedSubject, argsArray);
	}),
);
PROTO_FUNCTION.setProperty(
	"toString",
	nativeVMFunc((_vm, subject, _args) => {
		assert(
			subject instanceof VMFunction,
			"Function.prototype.toString can only be called on a Function",
		);
		const value = `Function#${subject.functionID}`;
		return { type: "string", value };
	}),
);

PROTO_OBJECT.setProperty(
	"toString",
	nativeVMFunc(() => ({ type: "string", value: "[object Object]" })),
);
PROTO_OBJECT.setProperty(
	"hasOwnProperty",
	nativeVMFunc((vm, subject, args) => {
		subject = vm.coerceToObject(subject);
		const name = vm.coerceToString(args[0] || { type: "undefined" });
		const ret = subject.containsOwnProperty(name);
		return { type: "boolean", value: ret };
	}),
);
PROTO_OBJECT.setProperty(
	"isPrototypeOf",
	nativeVMFunc((vm, subject, args) => {
		const candidate = vm.coerceToObject(subject);
		const obj = vm.coerceToObject(args[0] || { type: "undefined" });
		const ret = obj.walkPrototypeChain((cur) => cur.is(candidate) || null);
		return { type: "boolean", value: ret ?? false };
	}),
);

PROTO_ARRAY.setProperty(
	"push",
	nativeVMFunc((_vm, subject, args) => {
		assert(subject instanceof VMArray, "`this` must be an array");

		if (typeof args[0] !== "undefined") {
			subject.arrayElements.push(args[0]);
		}
		return { type: "undefined" };
	}),
);
PROTO_ARRAY.setProperty(
	"join",
	nativeVMFunc((vm, subject, args) => {
		if (!(subject instanceof VMArray)) {
			return vm.throwTypeError(
				"Array.prototype.join must be called on an Array",
			);
		}
		assert(
			subject instanceof VMArray,
			"vm bug: array property but this is not array",
		);

		const sepValue = args[0] || { type: "string", value: "" };
		if (sepValue.type !== "string") {
			return vm.throwError(
				"TypeError",
				"first argument (separator) must be string",
			);
		}

		const retStr = subject.arrayElements.map((value) => {
			return vm.coerceToString(value);
		}).join(sepValue.value);
		return { type: "string", value: retStr };
	}),
);

class VMFunction extends VMInvokable {
	static #lastID = 0;

	name: string | null = null;
	functionID: number = ++VMFunction.#lastID;
	override readonly canConstruct = true;

	constructor(public params: string[], public body: Node) {
		super();
	}

	run(vm: VM, _subject: JSValue, _args: JSValue[]) {
		try {
			vm.runStmt(this.body);
		} catch (e) {
			if (e.returnValue) {
				assert(
					typeof e.returnValue.type === "string",
					"return value uninitialized!",
				);
				return e.returnValue;
			}
			throw e;
		}

		return { type: "undefined" };
	}
}

PROTO_STRING.setProperty(
	"replace",
	nativeVMFunc((vm: VM, subject: JSValue, args: JSValue[]) => {
		assertIsObject(vm, subject);

		if (typeof subject.primitive !== "string") {
			return vm.throwTypeError(
				"String.prototype.replace must be called on a string primitive",
			);
		}

		const arg0: JSValue | undefined = args[0];
		const arg1: JSValue | undefined = args[1];

		if (arg0.type !== "string") {
			return vm.throwTypeError(
				"String.prototype.replace: first argument must be string",
			);
		}

		let retStr;
		if (arg1.type === "string") {
			assert(
				typeof subject.primitive === "string",
				"second argument is string; must be called on string",
			);
			retStr = subject.primitive.replace(arg0.value, arg1.value);
		} else if (arg1 instanceof VMInvokable) {
			retStr = subject.primitive.replace(arg0.value, () => {
				const ret = vm.performCall(arg1, { type: "undefined" }, [arg0]);
				if (ret.type !== "string") {
					return vm.throwTypeError(
						"invalid return value from passed function: " + ret.type,
					);
				}
				return ret.value;
			});
		} else {
			return vm.throwTypeError(
				"String.prototype.replace: invalid type for argument #2: " +
					arg1.type,
			);
		}

		return { type: "string", value: retStr };
	}),
);

PROTO_STRING.setProperty(
	"valueOf",
	nativeVMFunc((vm: VM, subject: JSValue, _: JSValue[]) => {
		const subjectObj = vm.coerceToObject(subject);
		if (typeof subjectObj.primitive !== "string") {
			return vm.throwError(
				"TypeError",
				"`this` is not a String (string wrapper)",
			);
		}
		return { type: "string", value: subjectObj.primitive };
	}),
);
PROTO_STRING.setProperty(
	"toString",
	nativeVMFunc((vm: VM, subject: JSValue, _: JSValue[]) => {
		const subjectObj = vm.coerceToObject(subject);
		if (typeof subjectObj.primitive !== "string") {
			return vm.throwError(
				"TypeError",
				"`this` is not a String (string wrapper)",
			);
		}
		return { type: "string", value: subjectObj.primitive };
	}),
);

PROTO_NUMBER.setProperty(
	"toString",
	nativeVMFunc((vm, subject, _args) => {
		assertIsObject(vm, subject);

		if (
			!Object.is(subject.proto, PROTO_NUMBER) ||
			typeof subject.primitive !== "number"
		) {
			return vm.throwTypeError(
				"Number.prototype.toString must be called on number",
			);
		}

		const value = Number.prototype.toString.call(subject.primitive);
		return { type: "string", value };
	}),
);

function addValueOf(
	proto: VMObject,
	primitiveType: PrimType,
	consName: string,
) {
	proto.setProperty(
		"valueOf",
		nativeVMFunc((vm, subject, _args) => {
			assertIsObject(vm, subject);

			if (
				!Object.is(subject.proto, proto) ||
				typeof subject.primitive !== primitiveType
			) {
				return vm.throwTypeError(
					`${consName}.prototype.valueOf must be called on an ${consName} instance`,
				);
			}

			const ret = { type: primitiveType, value: subject.primitive };
			assertIsValue(ret);
			return ret;
		}),
	);
}

addValueOf(PROTO_NUMBER, "number", "Number");
addValueOf(PROTO_STRING, "string", "String");
addValueOf(PROTO_BOOLEAN, "boolean", "Boolean");
addValueOf(PROTO_SYMBOL, "symbol", "Symbol");
addValueOf(PROTO_BIGINT, "bigint", "BigInt");

PROTO_REGEXP.setProperty(
	"test",
	nativeVMFunc((vm, subject, args) => {
		assertIsVMRegExp(vm, subject);

		const arg = args[0];
		if (arg.type !== "string") {
			return vm.throwTypeError("RegExp.test argument must be string");
		}

		const ret = subject.innerRE.test(arg.value);
		return { type: "boolean", value: ret };
	}),
);
PROTO_REGEXP.setProperty(
	"exec",
	nativeVMFunc((vm, subject, args) => {
		assertIsVMRegExp(vm, subject);

		if (args.length === 0 || args[0].type !== "string") {
			return vm.throwTypeError(
				"RegExp.prototype.exec must be called with a single string as argument",
			);
		}

		const str = args[0].value;
		assert(typeof str === "string", "first argument must be string");

		const nativeRet = subject.innerRE.exec(str);
		if (nativeRet === null) {
			return { type: "null" };
		}

		const ret = new VMArray();
		for (const item of nativeRet) {
			ret.arrayElements.push({ type: "string", value: item });
		}
		ret.setProperty("index", { type: "number", value: nativeRet.index });
		ret.setProperty("input", { type: "string", value: nativeRet.input });

		if (typeof nativeRet.groups === "object") {
			const groups = new VMObject();
			groups.proto = null;
			for (const groupName in nativeRet.groups) {
				const value = nativeRet.groups[groupName];
				groups.setProperty(groupName, { type: "string", value });
			}

			ret.setProperty("groups", groups);
		}

		// TODO property `indices`
		return ret;
	}),
);

abstract class Scope {
	isNew = false;
	this: JSValue | null = null;
	isCallWrapper = false;
	isSetStrict = false;

	parent: Scope | null = null;

	walkParents<T>(fn: (_: Scope) => T): T | null {
		let scope: Scope | null;
		scope = this;
		while (scope !== null) {
			const ret = fn(scope);
			if (typeof ret !== "undefined") {
				return ret;
			}
			scope = scope.parent;
		}
		return null;
	}

	isStrict() {
		return this.walkParents((scope) => {
			if (scope.isSetStrict) return true;
		}) || false;
	}

	getRoot(): Scope {
		let scope: Scope | null;
		scope = this;
		while (scope.parent !== null) {
			scope = scope.parent;
		}
		return scope;
	}

	getThis(): JSValue | null {
		let scope: Scope | null;
		for (scope = this; scope !== null; scope = scope.parent) {
			if (scope.this !== null) {
				return scope.this;
			}
		}
		return null;
	}
	getThisValue(globalObj: JSValue): JSValue {
		const vmThis = this.getThis();
		return vmThis !== null
			? vmThis
			: this.isStrict()
			? { type: "undefined" }
			: globalObj;
	}

	abstract defineVar(
		kind: DeclKind,
		name: string,
		valueOrThunk: JSValue | (() => JSValue),
	): void;
	abstract setVar(name: string, value: JSValue, vm?: VM): void;
	abstract lookupVar(name: string): JSValue | undefined;
	abstract deleteVar(name: string): boolean;
	abstract setDoNotDelete(name: string): void;
}

type DeclKind = "var" | "let" | "const";

function assertValidDeclKind(kind: string): asserts kind is DeclKind {
	assert(
		kind === "var" || kind === "let" || kind === "const",
		"`kind` must be one of 'var', 'let', or 'const'",
	);
}

class VarScope extends Scope {
	vars = new Map<string, JSValue | (() => JSValue)>();
	dontDelete = new Set<string>();

	// true iff this scope is the function's wrapper
	//  - each function has at least 2 nested scopes:
	//     - wrapper: only arguments are defined
	//     - body: this corresponds to the function's body in { }
	// this allows us to allow var to redefine an argument in the function
	isCallWrapper = false;

	defineVar(
		kind: DeclKind,
		name: string,
		valueOrThunk: JSValue | (() => JSValue),
	) {
		assertValidDeclKind(kind);

		// var decls bubble up to the top of the function's body
		if (kind === "var" && !this.isCallWrapper && this.parent !== null) {
			return this.parent.defineVar(kind, name, valueOrThunk);
		}

		if (this.vars.has(name)) {
			// redefinition, discard
			return;
		}

		this.vars.set(name, valueOrThunk);
	}

	setVar(name: string, value: JSValue, vm: VM) {
		assert(
			vm instanceof VM,
			"vm not passed (required to throw ReferenceError)",
		);
		if (this.vars.has(name)) this.vars.set(name, value);
		else if (this.parent) this.parent.setVar(name, value, vm);
		else if (this.isStrict()) {
			return vm.throwError("NameError", "unbound variable: " + name);
		}
	}

	lookupVar(name: string): JSValue | undefined {
		let value = this.vars.get(name);
		if (typeof value === "function") {
			value = value();
		}
		if (typeof value !== "undefined") return value;
		if (this.parent) return this.parent.lookupVar(name);
		return undefined;
	}

	deleteVar(name: string) {
		// TODO involve parent scopes
		if (this.dontDelete.has(name)) return false;
		return this.vars.delete(name);
	}

	setDoNotDelete(name: string) {
		this.dontDelete.add(name);
	}
}

class EnvScope extends Scope {
	dontDelete = new Set();

	constructor(public env: VMObject) {
		super();
	}

	defineVar(kind: DeclKind, name: string, value: JSValue): void {
		assert(
			kind === "var" || kind === "let" || kind === "const",
			"`kind` must be one of 'var', 'let', or 'const'",
		);
		this.env.defineProperty(name, {
			value,
			configurable: false,
			enumerable: true,
			writable: true,
		});
	}
	setVar(name: string, value: JSValue, vm?: VM): void {
		assert(
			vm instanceof VM,
			"bug: vm not passed (required to throw ReferenceError)",
		);

		// afaiu, this assert can only fail with a bug
		if (this.isSetStrict && !this.env.containsOwnProperty(name)) {
			return vm.throwError(
				"ReferenceError",
				"assignment to undeclared global variable: " + name,
			);
		}

		this.env.setProperty(name, value);
	}

	lookupVar(name: string): JSValue | undefined {
		if (!this.env.containsOwnProperty(name)) return undefined;
		return this.env.getProperty(name);
	}

	deleteVar(name: string): boolean {
		if (this.dontDelete.has(name)) {
			return false;
		}
		return this.env.deleteProperty(name);
	}

	setDoNotDelete(name: string) {
		this.dontDelete.add(name);
	}
}

const textOfSource = new Map<string, string>();

export class VM {
	globalObj = createGlobalObject();
	currentScope: Scope | null = null;
	synCtx: acorn.Node[] = [];

	//
	// VM state (variables, stack, heap, ...)
	//

	defineVar(
		kind: DeclKind,
		name: string,
		valueOrThunk: JSValue | (() => JSValue),
	) {
		assert(this.currentScope !== null, "there must be a scope");
		return this.currentScope.defineVar(kind, name, valueOrThunk);
	}
	setVar(name: string, value: JSValue, _vm?: VM) {
		assert(this.currentScope !== null, "there must be a scope");
		return this.currentScope.setVar(name, value, this);
	}
	deleteVar(name: string) {
		assert(this.currentScope !== null, "there must be a scope");
		return this.currentScope.deleteVar(name);
	}
	lookupVar(name: string) {
		assert(this.currentScope !== null, "there must be a scope");
		return this.currentScope.lookupVar(name);
	}
	setDoNotDelete(name: string) {
		assert(this.currentScope !== null, "there must be a scope");
		return this.currentScope.setDoNotDelete(name);
	}
	withScope<T>(inner: () => T): T {
		const scope = new VarScope();
		scope.parent = this.currentScope;
		this.currentScope = scope;

		try {
			return inner();
		} finally {
			assert(this.currentScope === scope, "stack manipulated!");
			this.currentScope = scope.parent;
		}
	}

	get currentCallWrapper() {
		assert(this.currentScope !== null, "there must be a scope");
		return this.currentScope.walkParents((scope) => {
			if (scope.isCallWrapper) return scope;
		});
	}

	#withSyntaxContext<T>(node: Node, inner: () => T): T {
		try {
			this.synCtx.push(node);
			return inner();
		} catch (e) {
			if (e instanceof ExceptionRequest) {
				return this.throwError(e.constructorName, e.message);
			}

			if (typeof e === "object" && e.context === undefined) {
				// preserve *some* context
				e.context = [...this.synCtx];
			}
			throw e;
		} finally {
			const check = this.synCtx.pop();
			assert(Object.is(check, node), "bug! syntax context manipulated");
		}
	}

	//
	// Statements
	//

	runScript({ text, path }: { path: string; text: string }) {
		const origPath = path;
		let counter = 0;
		while (textOfSource.has(path)) {
			path = origPath + counter;
			counter++;
		}
		textOfSource.set(path, text);

		const ast = acorn.parse(text, {
			ecmaVersion: "latest",
			sourceFile: path,
			locations: true,
		});

		return this.runProgram(ast);
	}

	runProgram(node: acorn.Program) {
		assert(node.sourceType === "script", "only script is supported");
		assert(node.type === "Program", "must be called with a Program node");

		hoistDeclarations(node);

		return this.#withSyntaxContext(node, () => {
			try {
				assert(this.currentScope === null, "nested program!");

				const topScope = new EnvScope(this.globalObj);
				this.currentScope = topScope;
				this.currentScope.this = this.globalObj;

				if (
					node.body.length > 0 &&
					node.body[0].type === "ExpressionStatement" &&
					node.body[0].directive === "use strict"
				) {
					this.currentScope.isSetStrict = true;
				}

				this.runBlockBody(node.body);

				assert(this.currentScope === topScope, "stack manipulated!");
				this.currentScope = null;
				return { outcome: "success" };
			} catch (error) {
				assert(
					error.continue === undefined && error.break === undefined,
					"vm bug: control-flow utility exception leaked!",
				);
				if (error instanceof ProgramException) {
					const excval = error.exceptionValue;
					const message = excval.type === "object"
						? excval.getProperty("message")
						: excval;
					return {
						outcome: "failure",
						message,
						error,
					};
				}

				throw error;
			}
		});
	}

	directEval(text: string) {
		let ast;
		try {
			ast = acorn.parse(text, {
				ecmaVersion: "latest",
				directSourceFile: text,
				locations: true,
			});
		} catch (err) {
			if (err instanceof SyntaxError) {
				// translate this into a SyntaxError into the running program
				this.throwError("SyntaxError", err.message);
			}
			throw err;
		}

		// force the semantics of a BlockStatement on the AST's root, then run
		// and return the completion value
		assert(
			ast.type === "Program",
			"result of parser is expected to be a Program",
		);

		return this.withScope(() => {
			return this.runBlockBody(ast.body);
		});
	}

	runBlockBody(body: acorn.Program["body"]): JSValue {
		let completion: JSValue = { type: "undefined" };
		for (const stmt of body) {
			// last iteration's CV becomes block's CV
			completion = this.runStmt(stmt);
		}
		return completion;
	}

	performCall(callee: VMInvokable, subject: JSValue, args: JSValue[]) {
		assert(
			callee instanceof VMInvokable,
			() => "callee is not a function (native or virtual)",
		);
		return callee.invoke(this, subject, args);
	}

	runStmt(node: acorn.Node): JSValue {
		return this.#withSyntaxContext(node, () => this._runStmt(node));
	}
	_runStmt(node: acorn.Node): JSValue {
		const stmt = <acorn.Statement> node;
		switch (stmt.type) {
			// each of these handlers returns the *completion value* of the statement (if any)

			case "EmptyStatement":
				return { type: "undefined" };

			case "BlockStatement":
				return this.withScope(() => {
					return this.runBlockBody(stmt.body);
				});

			case "TryStatement":
				try {
					return this.withScope(() => this.runStmt(stmt.block));
				} catch (err) {
					if (err instanceof ProgramException && stmt.handler) {
						assert(
							stmt.handler.type === "CatchClause",
							"parser bug: try statement's handler must be CatchClause",
						);
						assert(
							stmt.handler.param !== null && stmt.handler.param !== undefined,
							"unsuppored: handler without param",
						);
						assert(
							stmt.handler.param.type === "Identifier",
							"only supported: catch clause param Identifier",
						);

						const paramName = stmt.handler.param.name;
						const body = stmt.handler.body;
						return this.withScope(() => {
							this.defineVar("let", paramName, err.exceptionValue);
							this.setDoNotDelete(paramName);
							return this.runStmt(body);
						});
					} else {
						// either pass the ProgramException to another of the program's try blocks
						// or pass the AssertionError to the VM caller
						throw err;
					}
				} finally {
					this.withScope(() => {
						if (stmt.finalizer !== null && stmt.finalizer !== undefined) {
							return this.runStmt(stmt.finalizer);
						}
					});
				}

			case "ThrowStatement": {
				const exceptionValue = this.evalExpr(stmt.argument);
				throw new ProgramException(exceptionValue, this.synCtx);
			}

			case "FunctionDeclaration":
				assert(!stmt.expression, "unsupported func decl type: expression");
				assert(!stmt.generator, "unsupported func decl type: generator");
				assert(!stmt.async, "unsupported func decl type: async");
				return this.declareFunction(stmt);

			case "ExpressionStatement":
				// expression value becomes completion value
				return this.evalExpr(stmt.expression);

			case "IfStatement": {
				const test = this.evalExpr(stmt.test);

				if (this.isTruthy(test)) {
					return this.runStmt(stmt.consequent);
				} else if (stmt.alternate) {
					return this.runStmt(stmt.alternate);
				}
				return { type: "undefined" };
			}

			case "VariableDeclaration": {
				if (
					stmt.kind !== "var" && stmt.kind !== "let" && stmt.kind !== "const"
				) {
					throw new AssertionError("unsupported var decl type: " + stmt.kind);
				}

				let completion: JSValue = { type: "undefined" };

				for (const decl of stmt.declarations) {
					assert(
						decl.type === "VariableDeclarator",
						"decl type must be VariableDeclarator",
					);
					if (decl.id.type === "Identifier") {
						const name = decl.id.name;
						const value: JSValue = decl.init
							? this.evalExpr(decl.init)
							: { type: "undefined" };
						this.defineVar(stmt.kind, name, value);

						if (stmt.declarations.length === 1) {
							completion = value;
						}
					} else {
						throw new AssertionError(
							"unsupported declarator id type: " + decl.id.type,
						);
					}
				}

				return completion;
			}

			case "BreakStatement":
				assert(stmt.label === null, "break + label not yet implemented");
				throw { break: true };

			case "ContinueStatement":
				assert(stmt.label === null, "break + label not yet implemented");
				throw { continue: true };

			case "ReturnStatement": {
				if (stmt.argument === undefined || stmt.argument === null) {
					throw { returnValue: { type: "undefined" } };
				}
				const returnValue = this.evalExpr(stmt.argument);
				throw { returnValue };
			}

			case "ForStatement":
				return this.withScope(() => {
					let completion: JSValue = { type: "undefined" };

					if (stmt.init !== null && stmt.init !== undefined) {
						if (stmt.init.type === "VariableDeclaration") {
							this.runStmt(stmt.init);
						} else this.evalExpr(stmt.init);
					}

					while (
						stmt.test === null || stmt.test === undefined ||
						this.isTruthy(this.evalExpr(stmt.test))
					) {
						// keep overwriting, return the last iteration's completion value
						try {
							completion = this.runStmt(stmt.body);
						} catch (e) {
							if (e.break) break;
							else if (e.continue) {
								// do nothing, proceed with update
							} else throw e;
						}

						if (stmt.update !== null && stmt.update !== undefined) {
							this.evalExpr(stmt.update);
						}
					}

					return completion;
				});

			case "ForInStatement": {
				const iteree = this.evalExpr(stmt.right);
				return this.withScope(() => {
					let asmtTarget: acorn.Pattern;

					if (stmt.left.type === "VariableDeclaration") {
						assert(
							stmt.left.declarations.length === 1 &&
								stmt.left.declarations[0].type === "VariableDeclarator" &&
								stmt.left.declarations[0].init === null &&
								stmt.left.declarations[0].id.type === "Identifier",
							"only supported: single declaration with no init and a simple identifier as the pattern",
						);
						this.runStmt(stmt.left);
						asmtTarget = stmt.left.declarations[0].id;
					} else if (stmt.left.type === "Identifier") {
						asmtTarget = stmt.left;
					} else {
						throw new AssertionError(
							`in for(...in...) statement: left-hand side syntax not supported: ${stmt.left.type}`,
						);
					}

					assert(iteree instanceof VMObject, "only supported: object iteree");
					const properties = iteree.getOwnEnumerablePropertyNames();
					for (const name of properties) {
						let nameJSV: JSValue;
						if (typeof name === "string") {
							nameJSV = { type: "string", value: name };
						} else if (typeof name === "symbol") {
							nameJSV = { type: "symbol", value: name };
						} else {
							throw new AssertionError(
								`getOwnPropertyNames must return string or symbol, not ${typeof name}`,
							);
						}

						this.doAssignment(asmtTarget, nameJSV);
						this.runStmt(stmt.body);
					}

					return { type: "undefined" };
				});
			}

			case "WhileStatement": {
				let completion: JSValue = { type: "undefined" };
				try {
					while (this.coerceToBoolean(this.evalExpr(stmt.test))) {
						try {
							completion = this.runStmt(stmt.body);
						} catch (e) {
							if (!e.continue) throw e;
						}
					}
				} catch (e) {
					if (!e.break) throw e;
				}
				return completion;
			}

			case "SwitchStatement": {
				const discriminant = this.evalExpr(stmt.discriminant);

				const caseCount = stmt.cases.length;
				let caseIndex = null;
				let defaultIndex = null;
				for (let i = 0; i < caseCount; i++) {
					const branch = stmt.cases[i];
					if (
						typeof branch.test === "object" && branch.test !== null
					) {
						const testValue = this.evalExpr(branch.test);
						if (this.tripleEqualValues(discriminant, testValue)) {
							caseIndex = i;
							break;
						}
					} else {
						defaultIndex = i;
					}
				}

				if (caseIndex === null) caseIndex = defaultIndex;
				let completion: JSValue = { type: "undefined" };
				if (caseIndex !== null) {
					for (let i = caseIndex; i < caseCount; i++) {
						for (const substmt of stmt.cases[i].consequent) {
							completion = this.runStmt(substmt);
						}
					}
				}
				return completion;
			}

			default:
				throw new AssertionError("not a (supported) statement: " + stmt.type);
		}
	}

	//
	// Expressions
	//
	evalExpr(expr: acorn.Expression): JSValue {
		return this.#withSyntaxContext(expr, () => this._evalExpr(expr));
	}
	_evalExpr(expr: acorn.Expression): JSValue {
		assert(this.currentScope !== null, "there must be a scope");

		switch (expr.type) {
			case "AssignmentExpression": {
				let value = this.evalExpr(expr.right);

				assert(
					expr.left.type === "Identifier" ||
						expr.left.type === "MemberExpression",
					"only supported as assignment targets: Identifier and MemberExpression",
				);

				let binOp = "";

				if (expr.operator === "=") binOp = "";
				else if (expr.operator === "+=") binOp = "+";
				else if (expr.operator === "*=") binOp = "*";
				else if (expr.operator === "-=") binOp = "-";
				else if (expr.operator === "%=") binOp = "%";
				else if (expr.operator === "&=") binOp = "&";
				else if (expr.operator === "/=") binOp = "/";
				else if (expr.operator === "<<=") binOp = "<<";
				else if (expr.operator === ">>=") binOp = ">>";
				else if (expr.operator === ">>>=") binOp = ">>>";
				else if (expr.operator === "^=") binOp = "^";
				else if (expr.operator === "|=") binOp = "|";
				else {
					throw new AssertionError(
						`unsupported update assignment op. [${expr.operator}]`,
					);
				}

				if (binOp === "") {
					// no update
				} else {
					value = this.binExpr(binOp, expr.left, expr.right);
				}

				return this.doAssignment(expr.left, value);
			}

			case "UpdateExpression": {
				const num = this.coerceToNumber(this.evalExpr(expr.argument));
				const valuePre: JSValue = { type: "number", value: num };

				let valuePost: JSValue;
				if (expr.operator === "++") {
					const one: JSValue = { type: "number", value: 1 };
					valuePost = this.evalAddition(valuePre, one);
				} else if (expr.operator === "--") {
					valuePost = this.arithmeticOpNumeric("-", num, 1);
				} else {
					throw new AssertionError(
						"unsupported update operator: " + expr.operator,
					);
				}

				this.doAssignment(expressionToPattern(expr.argument), valuePost);

				if (expr.prefix) return valuePost;
				return valuePre;
			}

			case "FunctionExpression": {
				assert(!expr.expression, "unsupported: FunctionExpression.expression");
				assert(!expr.generator, "unsupported: FunctionExpression.generator");
				assert(!expr.async, "unsupported: FunctionExpression.async");
				return this.declareFunction(expr);
			}

			case "ObjectExpression": {
				const obj = new VMObject();

				for (const propertyNode of expr.properties) {
					assert(
						propertyNode.type === "Property",
						"node's type === 'Property'",
					);
					assert(propertyNode.method === false, "node's method === false");
					assert(
						propertyNode.shorthand === false,
						"node's shorthand === false",
					);

					let key: PropName;
					if (propertyNode.computed === true) {
						const keyVal = this.evalExpr(propertyNode.key);
						if (keyVal.type !== "string" && keyVal.type !== "symbol") {
							this.throwError(
								"TypeError",
								"only string and symbol are allowed as object keys",
							);
						}
						key = keyVal.value;
					} else {
						assert(
							propertyNode.key.type === "Identifier",
							"only supported: identifier as property name",
						);
						key = propertyNode.key.name;
					}

					if (propertyNode.kind === "init") {
						const value = this.evalExpr(propertyNode.value);
						obj.setProperty(key, value);
					} else if (
						propertyNode.kind === "get" || propertyNode.kind === "set"
					) {
						const func = this.evalExpr(propertyNode.value);
						if (!(func instanceof VMInvokable)) {
							throw new AssertionError(
								"VM bug: getter/setter was not evaluated as function?",
							);
						}
						obj.defineProperty(key, {
							[propertyNode.kind]: func,
							configurable: false,
							enumerable: false,
							writable: false,
						});
					} else {
						throw new AssertionError(
							"unsupported property kind: " + propertyNode.kind,
						);
					}
				}

				return obj;
			}

			case "ArrayExpression": {
				const array = new VMArray();
				array.arrayElements = expr.elements.map((elmNode) => {
					assert(elmNode !== null, "unexpected null in array expression");
					assert(
						elmNode.type !== "SpreadElement",
						"unsupported: [...spread] syntax in array literal",
					);
					return this.evalExpr(elmNode);
				});
				return array;
			}

			case "MemberExpression": {
				assert(!expr.optional, "unsupported: MemberExpression.optional");

				assert(expr.object.type !== "Super", "unsupported: super(...)");
				const object = this.coerceToObject(this.evalExpr(expr.object));

				let val;
				if (expr.computed) {
					assert(
						expr.property.type !== "PrivateIdentifier",
						"unsupported: private identifiers",
					);
					const key = this.evalExpr(expr.property);
					if (key.type === "string") {
						val = object.getProperty(key.value, this);
					} else if (key.type === "number") {
						val = object.getIndex(key.value);
					} else {
						throw new AssertionError(
							"MemberExpression: unsupported key type: " + key.type,
						);
					}
				} else if (expr.property.type === "Identifier") {
					val = object.getProperty(expr.property.name, this);
				} else {
					throw new AssertionError(
						"MemberExpression: !computed, but property not an Identifier",
					);
				}

				if (val === undefined) return { type: "undefined" };
				return val;
			}

			case "UnaryExpression": {
				if (expr.operator === "delete") {
					assert(expr.prefix, "parser bug: delete must be prefix");
					if (expr.argument.type === "Identifier") {
						const name = expr.argument.name;
						const didDelete = this.deleteVar(name);
						return { type: "boolean", value: didDelete };
					} else if (expr.argument.type === "MemberExpression") {
						assert(
							expr.argument.object.type !== "Super",
							"unsupported: super.xxx",
						);
						const obj = this.evalExpr(expr.argument.object);
						if (!(obj instanceof VMObject)) {
							this.throwTypeError("can't delete from non-object");
						}

						let property;
						assert(
							expr.argument.property.type !== "PrivateIdentifier",
							"unsupported: private identifiers",
						);
						if (expr.argument.computed) {
							const nameValue = this.evalExpr(expr.argument.property);
							if (nameValue.type !== "string") {
								this.throwTypeError("property type is not string");
							}
							property = nameValue.value;
						} else {
							assert(
								expr.argument.property.type === "Identifier",
								"parser bug.  unaryexpr.argument.computed ==> unaryexpr.argument is Identifier",
							);
							property = expr.argument.property.name;
						}

						const ret = obj.deleteProperty(property);
						return { type: "boolean", value: ret };
					} else {
						throw new AssertionError(
							"unsupported delete argument: " + expr.argument.type,
						);
					}
				} else if (expr.operator === "typeof") {
					if (expr.argument.type === "Identifier") {
						const value = this.currentScope.lookupVar(expr.argument.name);
						// particular case in the language: naked UNBOUND identifier result in undefined
						if (value === undefined) {
							return { type: "string", value: "undefined" };
						}
						if (value.type === "null") {
							return { type: "string", value: "object" };
						}
						return { type: "string", value: value.type };
					} else {
						const value = this.evalExpr(expr.argument);
						if (value.type === "null") {
							return { type: "string", value: "object" };
						}
						return { type: "string", value: value.type };
					}
				} else if (expr.operator === "!") {
					assert(expr.prefix === true, "only supported: expr.prefix === true");
					const value = this.coerceToBoolean(this.evalExpr(expr.argument));
					return { type: "boolean", value: !value };
				} else if (expr.operator === "+") {
					const value = this.coerceToNumeric(this.evalExpr(expr.argument));
					switch (typeof value) {
						case "number":
							return { type: "number", value };
						case "bigint":
							return { type: "bigint", value };
						default:
							return { type: "undefined" };
					}
				} else if (expr.operator === "-") {
					const value = this.coerceToNumeric(this.evalExpr(expr.argument));
					if (typeof value === "number") {
						return { type: "number", value: -value };
					}
					return { type: "bigint", value: -value };
				} else if (expr.operator === "~") {
					const value = this.coerceToNumeric(this.evalExpr(expr.argument));
					if (typeof value === "number") {
						return { type: "number", value: ~value };
					}
					return { type: "bigint", value: ~value };
				} else if (expr.operator === "void") {
					// evaluate and discard
					this.evalExpr(expr.argument);
					return { type: "undefined" };
				} else {
					throw new AssertionError("unsupported unary op: " + expr.operator);
				}
			}

			case "BinaryExpression":
				assert(
					expr.left.type !== "PrivateIdentifier",
					"unsupported: private identifier",
				);
				return this.binExpr(expr.operator, expr.left, expr.right);

			case "LogicalExpression": {
				if (expr.operator === "||") {
					const left = this.evalExpr(expr.left);
					if (this.isTruthy(left)) return left;
					return this.evalExpr(expr.right);
				} else if (expr.operator === "&&") {
					const left = this.evalExpr(expr.left);
					if (!this.isTruthy(left)) return left;
					return this.evalExpr(expr.right);
				} else if (expr.operator === "??") {
					const left = this.evalExpr(expr.left);
					if (left.type === "null" || left.type === "undefined") {
						return this.evalExpr(expr.right);
					}
					return left;
				} else {
					throw new AssertionError("unsupported logical op: " + expr.operator);
				}
			}

			case "ConditionalExpression": {
				const testValue = this.evalExpr(expr.test);
				const test = this.coerceToBoolean(testValue);
				// don't even eval the non-taken branch
				if (test) return this.evalExpr(expr.consequent);
				else return this.evalExpr(expr.alternate);
			}

			case "NewExpression": {
				const constructor = this.evalExpr(expr.callee);
				if (!(constructor instanceof VMInvokable)) {
					this.throwError("TypeError", "constructor must be callable");
				}
				const args = expr.arguments.map((argNode) => {
					assert(
						argNode.type !== "SpreadElement",
						"unsupported: new X(...spread) syntax",
					);
					return this.evalExpr(argNode);
				});
				return this.performNew(constructor, args);
			}

			case "CallExpression": {
				const args = expr.arguments.map((argNode) => {
					assert(
						argNode.type !== "SpreadElement",
						"unsupported: call(...spread) syntax",
					);
					return this.evalExpr(argNode);
				});
				let callThis: JSValue;
				let callee;

				if (
					expr.callee.type === "MemberExpression" &&
					expr.callee.property.type === "Identifier"
				) {
					assert(
						!expr.callee.optional,
						"only supported: member call with !optional",
					);
					assert(
						expr.callee.object.type !== "Super",
						"unsupported: super.property",
					);

					callThis = this.evalExpr(expr.callee.object);
					callThis = this.coerceToObject(callThis);

					if (expr.callee.computed) {
						callee = this.evalExpr(expr.callee);
					} else {
						const name = expr.callee.property.name;
						callee = callThis.getProperty(name);
					}

					if (callee === undefined) {
						throw new AssertionError(
							`can't find method ${name} in 'this'`,
						);
					}
				} else if (
					expr.callee.type === "Identifier" && expr.callee.name === "eval"
				) {
					// don't lookup "eval" as a variable, perform "direct eval"

					if (expr.arguments.length === 0) {
						return { type: "undefined" };
					}

					assert(
						expr.arguments[0].type !== "SpreadElement",
						"...spread syntax unsupported",
					);
					const arg = this.evalExpr(expr.arguments[0]);
					if (arg.type === "string") {
						return this.directEval(arg.value);
					} else {
						return arg;
					}
				} else {
					callThis = { type: "undefined" };
					assert(expr.callee.type !== "Super", "unsupported: super");
					callee = this.evalExpr(expr.callee);
					if (callee.type === "undefined" || callee.type === "null") {
						throw new AssertionError("can't invoke undefined/null");
					}
				}

				if (!(callee instanceof VMInvokable)) {
					return this.throwError("TypeError", "callee must be callable");
				}
				return this.performCall(callee, callThis, args);
			}

			case "ThisExpression": {
				assert(this.currentScope !== null, "there must be a scope");
				return this.currentScope.getThisValue(this.globalObj);
			}

			case "Identifier": {
				if (expr.name === "undefined") return { type: "undefined" };
				if (expr.name === "Infinity") {
					return { type: "number", value: Infinity };
				}
				if (expr.name === "NaN") return { type: "number", value: NaN };

				const value = this.lookupVar(expr.name);
				if (value === undefined) {
					this.throwError("ReferenceError", "unbound variable: " + expr.name);
				}

				return value;
			}

			case "Literal": {
				const value = expr.value;
				const type = typeof value;

				if (this.currentScope.isStrict()) {
					if (type === "number") {
						assert(
							expr.raw !== undefined,
							"parser bug: no value in number literal?",
						);
						if (expr.raw.match(/^0\d+/)) {
							// octal literals forbidden in strict mode
							this.throwError(
								"SyntaxError",
								"octal literals are forbidden in strict mode",
							);
						}
					}
				}

				if (expr.value === null) {
					return { type: "null" };
				} // the separate if cases help typescript
				// deno-fmt-ignore
				else if (type === "number")  { assert(typeof value == "number", "invalid value");  return { type: "number", value }; }
				else if (type === "string")  { assert(typeof value == "string", "invalid value");  return { type: "string", value }; }
				else if (type === "boolean") { assert(typeof value == "boolean", "invalid value"); return { type: "boolean", value }; }
				else if (type === "bigint")  { assert(typeof value == "bigint", "invalid value");  return { type: "bigint", value }; }
				else if (type === "object" && expr.value instanceof RegExp) {
					return createRegExpFromNative(this, expr.value);
				} else {
					throw new AssertionError(
						`unsupported literal value: ${typeof expr.value}`,
					);
				}
			}

			case "SequenceExpression":
				assert(
					expr.expressions.length >= 1,
					"parser bug: SequenceExpression must have at least one sub-expression",
				);
				for (let i = 0; i < expr.expressions.length - 1; i++) {
					this.evalExpr(expr.expressions[i]);
				}
				return this.evalExpr(expr.expressions[expr.expressions.length - 1]);

			default:
				throw new AssertionError(
					`unsupported expression node type: ${expr.type}`,
				);
		}
	}

	binExpr(
		operator: string,
		left: acorn.Expression,
		right: acorn.Expression,
	): JSValue {
		// expressions are passed directly to handler functions, so that these functions
		// can determine the evaluation order, and interleave evalExpr and type
		// coercions
		if (operator === "===") {
			return { type: "boolean", value: this.tripleEqual(left, right) };
		} else if (operator === "!==") {
			return { type: "boolean", value: !this.tripleEqual(left, right) };
		} else if (operator === "==") {
			return { type: "boolean", value: this.looseEqual(left, right) };
		} else if (operator === "!=") {
			return { type: "boolean", value: !this.looseEqual(left, right) };
		} else if (operator === "instanceof") {
			const av = this.evalExpr(left);
			let obj: VMObject | null = this.coerceToObject(av);

			const constructor = this.evalExpr(right);
			if (!(constructor instanceof VMObject)) {
				return { type: "boolean", value: false };
			}

			const proto = constructor.getProperty("prototype");
			if (!(proto instanceof VMObject)) {
				return this.throwError(
					"TypeError",
					"constructor's `prototype` property is not object",
				);
			}

			while (obj !== null) {
				assert(
					obj instanceof VMObject,
					"item in prototype chain is not object!",
				);
				if (obj.is(proto)) {
					return { type: "boolean", value: true };
				}
				obj = obj.proto;
			}

			return { type: "boolean", value: false };
		} else if (operator === "in") {
			let key: PropName;

			const lv = this.evalExpr(left);
			if (lv.type === "symbol") key = lv.value;
			else key = this.coerceToString(lv);

			const obj = this.coerceToObject(this.evalExpr(right));
			const found = obj.getProperty(key) !== undefined;
			return { type: "boolean", value: found };
		} else if (operator === "-") return this.arithmeticOp("-", left, right);
		else if (operator === "*") return this.arithmeticOp("*", left, right);
		else if (operator === "/") return this.arithmeticOp("/", left, right);
		else if (operator === "**") return this.arithmeticOp("**", left, right);
		else if (operator === "<<") return this.arithmeticOp("<<", left, right);
		else if (operator === ">>") return this.arithmeticOp(">>", left, right);
		else if (operator === "^") return this.arithmeticOp("^", left, right);
		else if (operator === "&") return this.arithmeticOp("&", left, right);
		else if (operator === "|") return this.arithmeticOp("|", left, right);
		else if (operator === "%") return this.arithmeticOp("%", left, right);
		else if (operator === ">>>") return this.arithmeticOp(">>>", left, right);

		const ap = this.coerceToPrimitive(this.evalExpr(left));
		const bp = this.coerceToPrimitive(this.evalExpr(right));

		if (operator === "+") {
			return this.evalAddition(ap, bp);
		} else if (operator === "<") {
			return { type: "boolean", value: this.isLessThan(ap, bp) };
		} else if (operator === "<=") {
			const ret = tri2bool(triNegate(this.compareLessThan(bp, ap)));
			return { type: "boolean", value: ret };
		} else if (operator === ">") {
			const ret = this.isLessThan(bp, ap);
			return { type: "boolean", value: ret };
		} else if (operator === ">=") {
			const ret = tri2bool(triNegate(this.compareLessThan(ap, bp)));
			return { type: "boolean", value: ret };
		}

		throw new AssertionError("unsupported binary op: " + operator);
	}

	evalAddition(a: JSPrimitive, b: JSPrimitive): JSValue {
		if (a.type === "string" || b.type === "string") {
			const astr = this.coerceToString(a);
			const bstr = this.coerceToString(b);
			return { type: "string", value: astr + bstr };
		}

		const ap = this.coerceToNumeric(a);
		const bp = this.coerceToNumeric(b);

		if (typeof ap === "number" && typeof bp === "number") {
			return { type: "number", value: ap + bp };
		} else if (typeof ap === "bigint" && typeof bp === "bigint") {
			return { type: "bigint", value: ap + bp };
		} else {
			return this.throwError(
				"SyntaxError",
				`unsupported types (${typeof ap}, ${typeof bp}) for operator +`,
			);
		}
	}

	arithmeticOp(
		op: string,
		left: acorn.Expression,
		right: acorn.Expression,
	): JSValue {
		const av = this.evalExpr(left);
		const bv = this.evalExpr(right);

		const a = this.coerceToNumeric(av);
		const b = this.coerceToNumeric(bv);
		return this.arithmeticOpNumeric(op, a, b);
	}

	arithmeticOpNumeric(
		op: string,
		a: number | bigint,
		b: number | bigint,
	): JSValue {
		// this could be shortened by taking advantage of JS's dynamicness, but
		// this version makes it easier to transition to statically-typed impls
		if (typeof a === "number" && typeof b === "number") {
			switch (op) {
				case "**":
					return { type: "number", value: a ** b };
				case "*":
					return { type: "number", value: a * b };
				case "+":
					return { type: "number", value: a + b };
				case "-":
					return { type: "number", value: a - b };
				case "<<":
					return { type: "number", value: a << b };
				case ">>":
					return { type: "number", value: a >> b };
				case "^":
					return { type: "number", value: a ^ b };
				case "&":
					return { type: "number", value: a & b };
				case "|":
					return { type: "number", value: a | b };
				case "/": {
					// deno-fmt-ignore
					const value 
						= Object.is(b, +0) ? Infinity 
						: Object.is(b, +0) ? -Infinity 
						: (a / b);
					return { type: "number", value };
				}
				case "%":
					return { type: "number", value: a % b };
				case ">>>":
					return { type: "number", value: a >>> b };
				default:
					this.throwError(
						"SyntaxError",
						"unsupported/invalid arithmetic operator: " + op,
					);
			}
		} else if (typeof a === "bigint" && typeof b === "bigint") {
			switch (op) {
				case "**":
					return { type: "bigint", value: a ** b };
				case "*":
					return { type: "bigint", value: a * b };
				case "+":
					return { type: "bigint", value: a + b };
				case "-":
					return { type: "bigint", value: a - b };
				case "<<":
					return { type: "bigint", value: a << b };
				case ">>":
					return { type: "bigint", value: a >> b };
				case "^":
					return { type: "bigint", value: a ^ b };
				case "&":
					return { type: "bigint", value: a & b };
				case "|":
					return { type: "bigint", value: a | b };
				case "/":
					return b == 0n
						? { type: "number", value: Infinity }
						: { type: "bigint", value: (a / b) };
				case "%":
					return { type: "bigint", value: a % b };
				case ">>>":
					return { type: "bigint", value: a >> b };
				default:
					this.throwError(
						"SyntaxError",
						"unsupported/invalid arithmetic operator: " + op,
					);
			}
		} else {
			this.throwError(
				"TypeError",
				"can't mix number and bigint in arithmetic operations",
			);
		}
	}

	compareLessThan(a: JSPrimitive, b: JSPrimitive): Tri {
		if (a.type === "string" && b.type === "string") {
			// we could use the host JS's builtins, but we want to get
			// close to the spec for a future translation

			const limit = Math.min(a.value.length, b.value.length);

			for (let i = 0; i < limit; ++i) {
				const ac = a.value.codePointAt(i);
				assert(ac !== undefined, "bug! index out of range");

				const bc = b.value.codePointAt(i);
				assert(bc !== undefined, "bug! index out of range");

				if (ac < bc) return true;
				if (ac > bc) return false;
			}

			if (a.value.length < b.value.length) return true;
			return false;
		} else if (a.type === "bigint" && b.type === "string") {
			const bb = stringToBigInt(b.value);
			if (bb === undefined) return "neither";
			return a.value < bb;
		} else if (a.type === "string" && b.type === "bigint") {
			const aa = stringToBigInt(a.value);
			if (aa === undefined) return "neither";
			return aa < b.value;
		} else {
			const an = this.coerceToNumeric(a);
			const bn = this.coerceToNumeric(b);

			if (typeof an === "number") {
				if (Number.isNaN(an) || Number.isNaN(bn)) return "neither";
				if (an === -Infinity) return true;
				if (an === +Infinity) return false;

				if (typeof bn === "number") {
					if (bn === -Infinity) return false;
					if (bn === +Infinity) return true;
					return an < bn;
				} else if (typeof bn === "bigint") {
					// replacing a with floor(a) does not influence the comparison
					const aFloor = BigInt(Math.floor(an));
					return aFloor < bn;
				}
			} else if (typeof an == "bigint") {
				if (typeof bn === "number") {
					// replacing b with ceil(b) does not influence the comparison
					const bCeil = BigInt(Math.ceil(bn));
					return (an < bCeil);
				} else if (typeof bn === "bigint") {
					return (an < bn);
				}
			}
			throw "unreachable!";
		}
	}

	isLessThan(a: JSPrimitive, b: JSPrimitive): boolean {
		return tri2bool(this.compareLessThan(a, b));
	}

	makeFunction(paramNodes: Node[], body: Node, options: FnBuildOptions = {}) {
		const params = paramNodes.map((paramNode) => {
			assert(
				paramNode.type === "Identifier",
				"unsupported: func params of type " + paramNode.type,
			);
			return (<acorn.Identifier> paramNode).name;
		});

		assert(
			body.type === "BlockStatement",
			"only supported: BlockStatement as function body",
		);
		assert(this.currentScope !== null, "there must be a scope");

		const func = new VMFunction(params, body);
		if (!options.scopeStrictnessIrrelevant && this.currentScope.isStrict()) {
			func.isStrict = true;
		}

		if (!func.isStrict && body.type === "BlockStatement") {
			const stmts = (<acorn.BlockStatement> body).body;
			if (
				stmts.length > 0 &&
				stmts[0].type === "ExpressionStatement" &&
				stmts[0].directive === "use strict"
			) {
				func.isStrict = true;
			}
		}

		return func;
	}

	isTruthy(jsv: JSValue) {
		if (jsv.type === "object") {
			throw new AssertionError("not yet implemented: isTruthy for object");
		}

		if (jsv.type === "boolean") return jsv.value;
		else if (jsv.type === "string") return jsv.value.length > 0;
		else if (jsv.type === "undefined") return false;
		else if (jsv.type === "number") {
			if (Number.isNaN(jsv.value)) return false;
			return jsv.value !== 0;
		}

		throw new AssertionError(
			"not yet implemented: isTruthy for type: " + jsv.type,
		);
	}

	performNew(constructor: VMInvokable, args: JSValue[]) {
		if (!constructor.canConstruct) {
			return this.throwError(
				"TypeError",
				"new X(...): X is callable but can't be used as constuctor",
			);
		}

		const initObj = new VMObject();

		let obj = constructor.invoke(this, initObj, args, { isNew: true });
		if (obj.type === "undefined") obj = initObj;

		assert(
			obj instanceof VMObject,
			"vm bug: invalid return type from constructor",
		);
		obj.defineProperty("constructor", {
			value: constructor,
			configurable: true,
			enumerable: false,
			writable: true,
		});

		let prototype = constructor.getProperty("prototype");
		if (prototype === undefined) {
			prototype = new VMObject();
		}

		obj.proto = this.coerceToObject(prototype);
		return obj;
	}

	doAssignment(targetExpr: acorn.Pattern, value: JSValue) {
		if (targetExpr.type === "MemberExpression") {
			assert(
				!targetExpr.optional,
				"unsupported: assignment to MemberExpression with .optional = true",
			);

			const objx = targetExpr.object;
			assert(objx.type !== "Super", "`super` not supported");
			const objVal = this.evalExpr(objx);
			const obj = this.coerceToObject(objVal);

			let property: JSValue;
			if (targetExpr.computed) {
				assert(
					targetExpr.property.type !== "PrivateIdentifier",
					"assignment to object property: private identifiers not yet supported",
				);
				property = this.evalExpr(targetExpr.property);
			} else {
				assert(
					targetExpr.property.type === "Identifier",
					"unsupported non-computed member property: " +
						targetExpr.property.type,
				);
				const propertyName = targetExpr.property.name;
				property = { type: "string", value: propertyName };
			}

			if (property.type === "number") {
				obj.setIndex(property.value, value);
			} else {
				let propertyName: string | symbol;
				if (!(property.type === "string" || property.type === "symbol")) {
					propertyName = this.coerceToString(property);
				} else {
					propertyName = property.value;
				}
				obj.setProperty(propertyName, value, this);
			}
		} else if (targetExpr.type === "Identifier") {
			const name = targetExpr.name;
			this.setVar(name, value);
		} else {
			throw new AssertionError(
				"unsupported assignment target: " + targetExpr.type,
			);
		}

		return value;
	}

	throwTypeError(message: string): never {
		return this.throwError("TypeError", message);
	}
	throwError(constructorName: string, message: string): never {
		const excCons = this.globalObj.getProperty(constructorName, this);
		if (!(excCons instanceof VMInvokable)) {
			throw new AssertionError("exception constructor must be invokable");
		}
		// avoid infinite recursion with performNew
		if (constructorName === "TypeError") {
			assert(excCons.canConstruct, "global  is not a constructor!");
		}
		const messageValue: JSValue = { type: "string", value: message };
		const exc = this.performNew(excCons, [messageValue]);
		throw new ProgramException(exc, this.synCtx);
	}

	coerceToObject(value: JSValue): VMObject {
		if (value instanceof VMObject) return value;

		// weird stupid case. why is BigInt not a constructor?
		if (value.type === "bigint") {
			const obj = new VMObject(PROTO_BIGINT);
			obj.primitive = value.value;
			return obj;
		}

		let cons: JSValue | undefined;
		switch (value.type) {
			case "number":
				cons = this.globalObj.getProperty("Number");
				break;
			case "boolean":
				cons = this.globalObj.getProperty("Boolean");
				break;
			case "string":
				cons = this.globalObj.getProperty("String");
				break;
			case "symbol":
				cons = this.globalObj.getProperty("Symbol");
				break;
			default:
				return this.throwTypeError(
					`can't convert value to object (type is ${value.type})`,
				);
		}

		assert(
			cons instanceof VMInvokable,
			"bug: primitive wrapper constructor must be invokable",
		);
		const obj = this.performNew(cons, [value]);
		assert(obj instanceof VMObject, "bug: new must return object");
		return obj;
	}

	coerceToBoolean(value: JSValue): boolean {
		let ret: boolean;

		if (value.type === "boolean") ret = value.value;
		else if (value.type === "undefined") ret = false;
		else if (value.type === "number") {
			// includes both +0 and -0
			ret = value.value !== 0 && !Number.isNaN(value.value);
		} else if (value.type === "bigint") ret = value.value !== 0n;
		else if (value.type === "string") ret = value.value !== "";
		else if (value.type === "symbol") ret = true;
		else if (value instanceof VMObject) ret = true;
		else {
			this.throwTypeError(
				`can't convert value to boolean (type ${value.type})`,
			);
		}

		return ret;
	}

	coerceToSymbol(value: JSValue): symbol {
		if (value.type === "symbol") return value.value;
		else if (value.type === "string") return Symbol(value.value);
		else this.throwTypeError(`can't convert ${value.type} to symbol`);
	}

	tripleEqual(leftExpr: acorn.Expression, rightExpr: acorn.Expression) {
		const left = this.evalExpr(leftExpr);
		const right = this.evalExpr(rightExpr);
		return this.tripleEqualValues(left, right);
	}
	tripleEqualValues(left: JSValue, right: JSValue) {
		if (right.type !== left.type) return false;

		if (left instanceof VMObject) return Object.is(left, right);

		if (right.type === "null" && left.type === "null") {
			return true;
		}

		if (
			(right.type === "boolean" && left.type === "boolean") ||
			(right.type === "string" && left.type === "string") ||
			(right.type === "number" && left.type === "number") ||
			(right.type === "bigint" && left.type === "bigint") ||
			(right.type === "symbol" && left.type === "symbol")
		) return left.value === right.value;

		if (right.type === "undefined" && left.type === "undefined") {
			return true;
		}

		throw new AssertionError("invalid value type: " + right.type);
	}

	looseEqual(leftExpr: acorn.Expression, rightExpr: acorn.Expression) {
		let left = this.evalExpr(leftExpr);
		let right = this.evalExpr(rightExpr);

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

		while (true) {
			assertIsValue(left);
			assertIsValue(right);

			if (left.type === right.type) {
				const t = left.type;
				let result;
				if (t === "object") result = Object.is(left, right);
				else if (t === "null" || t === "undefined") result = true;
				else if (
					t === "string" ||
					t === "number" ||
					t === "boolean" ||
					t === "bigint" ||
					t === "symbol"
				) {
					assert(right.type === left.type, "(for typescript)");
					result = left.value === right.value;
				} else throw new AssertionError("invalid value type: " + left.type);

				return result;
			}

			const leftIsUN = left.type === "undefined" || left.type === "null";
			const rightIsUN = right.type === "undefined" || right.type === "null";
			if (leftIsUN || rightIsUN) {
				return leftIsUN && rightIsUN;
			}

			if (left instanceof VMObject && !(right instanceof VMObject)) {
				left = this.coerceToPrimitive(left);
				continue;
			}
			if (!(left instanceof VMObject) && right instanceof VMObject) {
				right = this.coerceToPrimitive(right);
				continue;
			}

			// If one of the operands is a Symbol but the other is not, return false.
			if ((left.type === "symbol") !== (right.type === "symbol")) {
				return false;
			}

			// If one of the operands is a Boolean but the other is not,
			// convert the boolean to a number: true is converted to 1, and
			// false is converted to 0. Then compare the two operands
			// loosely again.
			if (left.type === "boolean") {
				left = { type: "number", value: (left.value ? 1 : 0) };
				continue;
			} else if (right.type === "boolean") {
				right = { type: "number", value: (right.value ? 1 : 0) };
				continue;
			} // Number to String: convert the string to a number. Conversion
			// failure results in NaN, which will guarantee the equality to
			// be false.
			else if (left.type === "string" && right.type === "number") {
				left = { type: "number", value: this.coerceToNumber(left) };
				continue;
			} else if (left.type === "number" && right.type === "string") {
				right = { type: "number", value: this.coerceToNumber(right) };
				continue;
			} // Number to BigInt: compare by their numeric value. If the
			// number is ±Infinity or NaN, return false.
			else if (
				(left.type === "number" && right.type === "bigint") ||
				(left.type === "bigint" && right.type === "number")
			) {
				return left.value === right.value;
			} // String to BigInt: convert the string to a BigInt using the
			// same algorithm as the BigInt() constructor. If conversion
			// fails, return false.
			else if (left.type === "string" && right.type === "bigint") {
				const value = this.coerceToBigInt(left);
				if (typeof value === "undefined") return false;
				left = { type: "bigint", value };
				continue;
			} else if (left.type === "bigint" && right.type === "string") {
				const value = this.coerceToBigInt(right);
				if (typeof value === "undefined") return false;
				right = { type: "bigint", value };
				continue;
			}

			assert(false, "unreachable!");
		}
	}

	coerceToPrimitive(value: JSValue, order = "valueOf first"): JSPrimitive {
		if (value instanceof VMObject) {
			const symCons = this.globalObj.getProperty("Symbol");
			assert(symCons instanceof VMObject, "malformed global: Symbol");
			const symToPrimitive = symCons.getProperty("toPrimitive");
			assert(
				symToPrimitive !== undefined,
				"malformed global: Symbol.toPrimitive",
			);
			assert(
				symToPrimitive.type === "symbol",
				"Symbol.toPrimitive must be symbol",
			);

			let prim: JSPrimitive | undefined;

			const tryCall = (methodName: string | symbol, args: JSValue[]) => {
				if (prim !== undefined) return;

				const method = value.getProperty(methodName);
				if (method instanceof VMInvokable) {
					const ret = method.invoke(this, value, args);
					// primitive: can be used
					if (!(ret instanceof VMObject) && ret.type !== "undefined") {
						prim = ret;
					}
				} else {
					// object has no method named ${methodName.toString()}
				}
			};

			tryCall(symToPrimitive.value, [{ type: "string", value: "default" }]);
			if (order === "valueOf first") {
				tryCall("valueOf", []);
				tryCall("toString", []);
			} else if (order === "toString first") {
				tryCall("toString", []);
				tryCall("valueOf", []);
			} else {throw new AssertionError(
					'invalid value for arg "order": ' + order,
				);}

			if (prim !== undefined) return prim;
			else {
				this.throwError(
					"TypeError",
					"value can't be converted to a primitive",
				);
			}
		} else {
			assert(typeof value.type === "string", "invalid value");
			return value;
		}
	}

	coerceToNumber(value: JSValue): number {
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

		if (value.type === "null") return 0;

		assertIsValue(value);
		if (value.type === "number") return value.value;
		if (value.type === "undefined") return NaN;
		if (value.type === "boolean") return value.value ? 1 : 0;
		if (value.type === "string") return +value.value;
		if (value.type === "bigint") return Number(value.value);
		if (value.type === "symbol") {
			return this.throwTypeError("can't convert symbol to number");
		}
		if (value instanceof VMObject) {
			return this.coerceToNumber(this.coerceToPrimitive(value));
		}
		throw new AssertionError("unreachable code!");
	}

	coerceToNumeric(value: JSValue): number | bigint {
		const prim = this.coerceToPrimitive(value);
		if (prim.type === "number" || prim.type === "bigint") {
			return prim.value;
		}
		return this.coerceToNumber(prim);
	}

	coerceToBigInt(value: JSValue): bigint | undefined {
		if (value instanceof VMObject) {
			value = this.coerceToPrimitive(value);
		}

		if (
			value.type === "null" || value.type === "undefined" ||
			value.type === "symbol"
		) {
			this.throwError(
				"TypeError",
				"can't convert to BigInt from " + value.type,
			);
		}

		let ret;
		if (value.type === "number") ret = BigInt(value.value);
		else if (value.type === "boolean") ret = BigInt(value.value ? 1 : 0);
		else if (value.type === "string") {
			try {
				ret = BigInt(value.value);
			} catch (e) {
				if (e instanceof SyntaxError) ret = undefined;
				else throw e;
			}
		} else if (value.type === "bigint") ret = value.value;

		return ret;
	}

	coerceToString(value: JSValue): string {
		if (value instanceof VMObject) {
			// Objects are first converted to a primitive by calling its [Symbol.toPrimitive]() (with "string" as hint), toString(), and valueOf() methods, in that order. The resulting primitive is then converted to a string.
			const prim = this.coerceToPrimitive(value, "toString first");
			if (prim.type === "undefined") {
				throw new AssertionError(
					"VM bug: object could not be converted to string (at least Object.prototype.toString should have been called)",
				);
			}
			return this.coerceToString(prim);
		}

		let str;
		if (value.type === "null") str = "null";
		else {
			if (value.type === "string") str = value.value;
			else if (value.type === "undefined") str = "undefined";
			else if (value.type === "boolean") str = value.value ? "true" : "false";
			else if (value.type === "number") {
				str = Number.prototype.toString.call(value.value);
			} else if (value.type === "bigint") {
				str = BigInt.prototype.toString.call(value.value);
			} else if (value.type === "symbol") {
				str = Symbol.prototype.toString.call(value.value);
			} else throw "unreachable";
		}

		return str;
	}

	declareFunction(decl: {
		id?: acorn.Identifier | null;
		params: Node[];
		body: Node;
	}) {
		const func = this.makeFunction(decl.params, decl.body);

		if (decl.id === null || typeof decl.id === "undefined") {
			/* nothing to do */
		} else if (decl.id.type === "Identifier") {
			const name = decl.id.name;
			func.setProperty("name", { type: "string", value: name });
			this.defineVar("var", name, func);
		} else {
			throw new AssertionError(
				"unsupported identifier for function declaration: " + decl.id,
			);
		}

		return func;
	}
}

function stringToBigInt(s: string): bigint | undefined {
	try {
		return BigInt(s);
	} catch (e) {
		if (e instanceof SyntaxError) return undefined;
		throw e;
	}
}

type Tri = boolean | "neither";

function triNegate(tri: Tri): Tri {
	if (tri === "neither") return "neither";
	return !tri;
}

function tri2bool(tri: Tri, def: boolean = false): boolean {
	if (tri === "neither") return def;
	return tri;
}

type NativeFunc = (
	this: VMInvokable,
	vm: VM,
	subject: JSValue,
	args: JSValue[],
	options: InvokeOpts,
) => JSValue;

interface NativeFuncOptions {
	isConstructor?: boolean;
}

function nativeVMFunc(
	innerImpl: NativeFunc,
	options: NativeFuncOptions = {},
): VMInvokable {
	return new class extends VMInvokable {
		canConstruct = options.isConstructor ?? false;
		// in innerImpl, `this` is the VMInvokable object
		run = innerImpl;
	}();
}

interface FnBuildOptions {
	scopeStrictnessIrrelevant?: boolean;
}

function assertIsVMRegExp(vm: VM, obj: JSValue): asserts obj is VMRegExp {
	assertIsObject(vm, obj);
	if (obj.innerRE === undefined) {
		return vm.throwError("TypeError", "expected a RegExp!");
	}
}

function createRegExpFromNative(vm: VM, innerRE: RegExp): VMRegExp {
	const obj = new VMObject(PROTO_REGEXP);
	obj.innerRE = innerRE;
	obj.setProperty("source", { type: "string", value: innerRE.source });
	assertIsVMRegExp(vm, obj);

	// lastIndex must be an own property (there is a dedicated test262 case)
	obj.defineProperty("lastIndex", {
		set: nativeVMFunc((vm, subject, args) => {
			assertIsVMRegExp(vm, subject);
			const arg = args[0] || { type: "undefined" };
			if (arg.type !== "number") {
				return vm.throwTypeError("property lastIndex must be set to a number");
			}
			subject.innerRE.lastIndex = arg.value;
			return { type: "undefined" };
		}),
		writable: true,
		enumerable: false,
		configurable: false,
	});

	return obj;
}

function createGlobalObject() {
	const G = new VMObject();

	const consError = nativeVMFunc((vm, subject, args) => {
		assertIsObject(vm, subject);
		subject.setProperty("message", args[0]);
		return subject;
	}, { isConstructor: true });
	G.setProperty("Error", consError);
	const protoError = consError.getProperty("prototype");
	assert(
		protoError instanceof VMObject,
		"bug: function.prototype must be object",
	);
	protoError.setProperty("name", { type: "string", value: "Error" });

	function createSimpleErrorType(name: string) {
		const Error = G.getOwnProperty("Error");
		assert(Error instanceof VMInvokable, "!");

		const parentProto = Error.getProperty("prototype");
		assert(parentProto instanceof VMObject, "!");

		const proto = new VMObject(parentProto);
		proto.setProperty("name", { type: "string", value: name });

		G.setProperty(
			name,
			new class extends VMInvokable {
				canConstruct = true;
				constructor() {
					super(proto);
				}
				override run(
					vm: VM,
					subject: JSValue,
					args: JSValue[],
					options: InvokeOpts,
				): JSValue {
					return Error.run(vm, subject, args, options);
				}
			}(),
		);
	}

	createSimpleErrorType("TypeError");
	createSimpleErrorType("SyntaxError");
	createSimpleErrorType("ReferenceError");
	createSimpleErrorType("RangeError");
	createSimpleErrorType("NameError");

	const consObject = nativeVMFunc((vm, subject, args) => {
		const callWrapper = vm.currentCallWrapper;
		assert(callWrapper instanceof Scope, "there must be a call scope here");
		assert(
			typeof callWrapper.isNew === "boolean",
			"there must be a new in the scope stack here",
		);
		if (callWrapper.isNew) {
			// when called via new, subject is already a freshly created object. sufficient to be returned from this constructor
			return subject;
		}

		const arg: JSValue = args[0] || { type: "undefined" };
		if (arg.type === "undefined" || arg.type === "null") {
			return new VMObject();
		}

		return vm.coerceToObject(arg);
	}, { isConstructor: true });
	consObject.setProperty("prototype", PROTO_OBJECT);
	consObject.setProperty(
		"defineProperty",
		nativeVMFunc((vm: VM, _: JSValue, args: JSValue[]): JSValue => {
			const [obj, name, descriptor] = args;
			if (!(obj instanceof VMObject)) {
				return vm.throwTypeError(
					"Object.defineProperty: first argument must be object",
				);
			}
			if (name.type !== "string") {
				return vm.throwTypeError(
					"Object.defineProperty: second argument must be string",
				);
			}

			assert(
				descriptor instanceof VMObject,
				"Object.defineProperty: third argument must be object",
			);

			// descriptorValue is a VM value
			if (descriptor.type !== "object") {
				return vm.throwError("TypeError", "invalid descriptor: not an object");
			}

			let getter: VMInvokable | undefined;
			let setter: VMInvokable | undefined;
			if (
				descriptor.containsOwnProperty("get") ||
				descriptor.containsOwnProperty("set")
			) {
				const checkFunc = (key: "get" | "set"): VMInvokable | undefined => {
					let value = descriptor.getProperty(key);
					if (value !== undefined && value.type === "undefined") {
						value = undefined;
					}

					if (value !== undefined && !(value instanceof VMInvokable)) {
						return vm.throwError(
							"TypeError",
							`invalid descriptor: '${key}' is not a function`,
						);
					}
					return value;
				};

				getter = checkFunc("get");
				setter = checkFunc("set");
			}

			function parseBool(key: PropName): boolean {
				const value = (<VMObject> descriptor).getProperty(key);
				if (value === undefined || value.type === "undefined") {
					return true;
				}
				if (value.type !== "boolean") {
					return vm.throwError(
						"TypeError",
						"invalid descriptor: `writable` is not a boolean",
					);
				}
				return value.value;
			}

			const writable = parseBool("writable");
			const configurable = parseBool("configurable");
			const enumerable = parseBool("enumerable");

			obj.defineProperty(name.value, {
				get: getter,
				set: setter,
				value: descriptor.getProperty("value"),
				writable,
				configurable,
				enumerable,
			});
			return { type: "undefined" };
		}),
	);
	consObject.setProperty(
		"getOwnPropertyDescriptor",
		nativeVMFunc((vm, _subject, args) => {
			const obj: VMObject = vm.coerceToObject(args[0] || { type: "undefined" });
			const name = args[1];
			if (name === undefined || name.type === "undefined") {
				return { type: "undefined" };
			}

			if (!(name.type === "string" || name.type === "symbol")) {
				return vm.throwTypeError("Invalid type for an object property");
			}

			const descriptor = obj.getOwnPropertyDescriptor(name.value);
			if (descriptor === undefined) {
				return { type: "undefined" };
			}

			if (descriptor.value === undefined) {
				descriptor.value = { type: "undefined" };
			}

			const encoded = new VMObject();
			if (descriptor.get !== undefined) {
				encoded.setProperty("get", descriptor.get);
			}
			if (descriptor.set !== undefined) {
				encoded.setProperty("set", descriptor.set);
			}
			encoded.setProperty("value", obj.resolveDescriptor(descriptor));
			encoded.setProperty("writable", {
				type: "boolean",
				value: descriptor.writable,
			});
			encoded.setProperty("enumerable", {
				type: "boolean",
				value: descriptor.enumerable,
			});
			encoded.setProperty("configurable", {
				type: "boolean",
				value: descriptor.configurable,
			});
			return encoded;
		}),
	);
	consObject.setProperty(
		"getOwnPropertyNames",
		nativeVMFunc((vm, _subject, args) => {
			const obj: VMObject = vm.coerceToObject(args[0] || { type: "undefined" });
			const names = obj.getOwnPropertyNames();
			const ret = new VMArray();
			for (const name of names) {
				assert(typeof name === "string", "unsuppored: symbol properties");
				ret.arrayElements.push({ type: "string", value: name });
			}
			return ret;
		}),
	);
	consObject.setProperty(
		"preventExtensions",
		nativeVMFunc((vm, _subject, args) => {
			const arg = args[0] || { type: "undefined" };
			if (!(arg instanceof VMObject)) {
				return vm.throwError("TypeError", "argument must be object");
			}

			arg.extensionAllowed = false;
			return arg;
		}),
	);
	consObject.setProperty(
		"getPrototypeOf",
		nativeVMFunc((vm, _subject, args) => {
			const arg = args[0] || { type: "undefined" };
			if (!(arg instanceof VMObject)) {
				return vm.throwError("TypeError", "argument must be object");
			}

			if (arg.proto === null) return { type: "null" };
			return arg.proto;
		}),
	);
	consObject.setProperty(
		"isPrototypeOf",
		nativeVMFunc((vm, _subject, args) => {
			const obj = vm.coerceToObject(args[0] || { type: "undefined" });
			const candidate = args[1];
			if (!(candidate instanceof VMObject)) {
				return vm.throwError(
					"TypeError",
					"argument 2 (the candidate prototype) must be an object",
				);
			}
			const ret = obj.walkPrototypeChain((cur) => cur.is(candidate) || null);
			return { type: "boolean", value: ret ?? false };
		}),
	);
	G.setProperty("Object", consObject);

	function addPrimitiveWrapperConstructor(
		name: string,
		prototype: VMObject,
		primType: PrimType,
		coercer: (vm: VM, value: JSValue) => VMObject["primitive"],
		postInit?: (vm: VM, obj: VMObject) => void,
	) {
		const cons = nativeVMFunc((vm, subject, args, options): JSValue => {
			const arg: JSValue = args[0] === undefined
				? { type: "undefined" }
				: args[0];

			const prim = coercer(vm, arg);
			if (options.isNew) {
				subject = new VMObject(prototype);
				subject.primitive = prim;
				if (postInit) postInit(vm, subject);
				return subject;
			}

			const ret = { type: primType, value: prim };
			assertIsValue(ret);
			return ret;
		}, { isConstructor: true });

		G.setProperty(name, cons);
		cons.setProperty("prototype", prototype);
		return cons;
	}

	addPrimitiveWrapperConstructor(
		"Boolean",
		PROTO_BOOLEAN,
		"boolean",
		(vm, x) => vm.coerceToBoolean(x),
	);

	const consNumber = addPrimitiveWrapperConstructor(
		"Number",
		PROTO_NUMBER,
		"number",
		(vm, x) => x.type === "undefined" ? 0 : vm.coerceToNumber(x),
	);
	consNumber.setProperty("POSITIVE_INFINITY", {
		type: "number",
		value: Infinity,
	});
	consNumber.setProperty("NEGATIVE_INFINITY", {
		type: "number",
		value: -Infinity,
	});
	consNumber.setProperty("MIN_VALUE", {
		type: "number",
		value: Number.MIN_VALUE,
	});
	consNumber.setProperty("MAX_VALUE", {
		type: "number",
		value: Number.MAX_VALUE,
	});

	consNumber.defineProperty("NaN", {
		value: { type: "number", value: NaN },
		configurable: false,
		writable: false,
		discardWriteSilently: true,
		enumerable: false,
	});
	G.defineProperty("NaN", {
		value: { type: "number", value: NaN },
		configurable: false,
		writable: false,
		discardWriteSilently: true,
		enumerable: false,
	});

	G.setProperty(
		"BigInt",
		nativeVMFunc((vm, subject, args) => {
			if (subject.type !== "undefined") {
				return vm.throwError(
					"TypeError",
					"BigInt can't be called as constructor (new BigInt(...))",
				);
			}

			const value = vm.coerceToBigInt(args[0]);
			if (typeof value === "bigint") {
				return { type: "bigint", value };
			}
			return vm.throwError("SyntaxError", "can't convert to value to bigint");
		}),
	);

	const consString = addPrimitiveWrapperConstructor(
		"String",
		PROTO_STRING,
		"string",
		(vm, x) => x.type === "undefined" ? "" : vm.coerceToString(x),
		(_, obj) => {
			assert(typeof obj.primitive === "string", "postinit string");
			obj.setProperty("length", {
				type: "number",
				value: obj.primitive.length,
			});
		},
	);
	consString.setProperty(
		"fromCharCode",
		nativeVMFunc((vm, _subject, args) => {
			const arg = args[0];
			if (arg === undefined || arg.type === "undefined") {
				return { type: "string", value: "" };
			}

			if (arg.type !== "number") {
				return vm.throwTypeError(
					"String.fromCharCode requires a numeric code point, not " + arg.type,
				);
			}

			return { type: "string", value: String.fromCharCode(arg.value) };
		}),
	);

	const consSymbol = addPrimitiveWrapperConstructor(
		"Symbol",
		PROTO_SYMBOL,
		"symbol",
		(vm, x) => vm.coerceToSymbol(x),
	);
	// we import some well-known symbols from the host JS
	// TODO stop doing this; define our own Symbol representation and our own well-defined symbols
	consSymbol.setProperty("toPrimitive", {
		type: "symbol",
		value: Symbol.toPrimitive,
	});

	const consArray = nativeVMFunc((_vm, _, args, callFlags) => {
		assert(
			callFlags.isNew ?? false,
			"unsupported: Array not called via new Array",
		);

		// TODO same as `arguments`... avoid the copy?
		const array = new VMArray();
		array.arrayElements.push(...args);
		return array;
	}, { isConstructor: true });
	G.setProperty("Array", consArray);
	consArray.setProperty(
		"isArray",
		nativeVMFunc((_vm, subject, _args) => ({
			type: "boolean",
			value: subject instanceof VMArray,
		})),
	);
	consArray.setProperty("prototype", PROTO_ARRAY);

	const consFunction = nativeVMFunc((vm, _subject, args) => {
		// even when invoked as `new Function(...)`, discard this, return another object

		if (args.length === 0 || args[0].type !== "string") {
			return vm.throwTypeError(
				"new Function() must be invoked with function's body as text (string)",
			);
		}

		const text = args[0].value;
		const ast = acorn.parse(text, {
			ecmaVersion: "latest",
			allowReturnOutsideFunction: true,
			directSourceFile: text,
			locations: true,
		});
		const body: acorn.Statement[] = ast.body.map((item) => {
			assert(
				item.type !== "ImportDeclaration" &&
					item.type !== "ExportNamedDeclaration" &&
					item.type !== "ExportDefaultDeclaration" &&
					item.type !== "ExportAllDeclaration",
				`unsupported program item type: ${item.type}`,
			);
			return item;
		});
		const blockStmt: acorn.BlockStatement = {
			...ast,
			body,
			type: "BlockStatement",
		};
		return vm.makeFunction([], blockStmt, { scopeStrictnessIrrelevant: true });
	}, { isConstructor: true });
	G.setProperty("Function", consFunction);
	consFunction.setProperty("prototype", PROTO_FUNCTION);

	const consRegExp = nativeVMFunc((vm, _subject, args) => {
		const arg = args[0];
		if (arg.type !== "string") {
			return vm.throwTypeError("RegExp constructor argument must be string");
		}
		return createRegExpFromNative(vm, new RegExp(arg.value));
	}, { isConstructor: true });
	G.setProperty("RegExp", consRegExp);
	consRegExp.setProperty("prototype", PROTO_REGEXP);

	G.setProperty(
		"eval",
		nativeVMFunc((vm, _subject, args): JSValue => {
			// this function is only looked up for indirect eval; direct eval has a
			// dedicated path in the parser

			// we're calling directEval but this is indirect eval. the scope where
			// the passed code is evaluated in the global scope, not the one
			// where the call appears
			if (args.length === 0) {
				return { type: "undefined" };
			}

			if (args[0].type !== "string") {
				return vm.throwTypeError("eval must be called with a string");
			}

			// the comments are from:
			// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval
			assert(vm.currentScope instanceof Scope, "there must be a scope where");
			const savedScope = vm.currentScope;
			const rootScope = vm.currentScope.getRoot();
			try {
				// Indirect eval works in the global scope rather than the local
				// scope, and the code being evaluated doesn't have access to
				// local variables within the scope where it's being called
				//
				// Indirect eval does not inherit the strictness of the
				// surrounding context, and is only in strict mode if the source
				// string itself has a "use strict" directive.
				vm.currentScope = rootScope;
				return vm.directEval(args[0].value);
			} finally {
				vm.currentScope = savedScope;
			}
		}),
	);

	G.setProperty(
		"nativeHello",
		nativeVMFunc(() => {
			console.log("hello world!");
			return { type: "undefined" };
		}),
	);

	G.setProperty(
		"$print",
		nativeVMFunc((_vm, _subject, args) => {
			for (const arg of args) {
				console.log(arg);
			}
			return { type: "undefined" };
		}),
	);

	G.setProperty(
		"$toPrimitive",
		nativeVMFunc((vm, _subject, args) => {
			if (args.length !== 1) {
				return vm.throwError(
					"TypeError",
					"$toPrimitive must be called with 1 argument",
				);
			}
			return vm.coerceToPrimitive(args[0]);
		}),
	);

	G.setProperty(
		"isNaN",
		nativeVMFunc((vm, _, args) => {
			const arg = args[0] || { type: "undefined" };
			const numArg = vm.coerceToNumber(arg);
			return { type: "boolean", value: Number.isNaN(numArg) };
		}),
	);

	const objMath = new VMObject();
	G.setProperty("Math", objMath);

	objMath.setProperty(
		"pow",
		nativeVMFunc((vm, _, args) => {
			const arg0 = args[0] || { type: "undefined" };
			const arg1 = args[1] || { type: "undefined" };

			const base = vm.coerceToNumber(arg0);
			const exp = vm.coerceToNumber(arg1);
			const res = Math.pow(base, exp);
			return { type: "number", value: res };
		}),
	);
	objMath.defineProperty("E", {
		value: { type: "number", value: 2.718281828459045 },
		configurable: false,
		writable: false,
		discardWriteSilently: true,
		enumerable: false,
	});

	for (const name of G.getOwnPropertyNames()) {
		const value = G.getOwnProperty(name);

		if (typeof name === "string" && value instanceof VMInvokable) {
			// value is a constructor
			value.setProperty("name", { type: "string", value: name });

			const prototype = value.getProperty("prototype");
			assert(
				prototype instanceof VMObject,
				"constructor must have .prototype property",
			);
			prototype.setProperty("name", { type: "string", value: name });
		}
	}

	return G;
}

function expressionToPattern(argument: acorn.Expression): acorn.Pattern {
	if (
		argument.type === "Identifier" ||
		argument.type === "MemberExpression"
	) return argument;
	throw new AssertionError(
		"bug: expression can't be used as pattern, type " + argument.type,
	);
}

function hoistDeclarations(_node: acorn.Node) {
	// TODO!
}

// vim:ts=4:sts=0:sw=0:et
