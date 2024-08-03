import * as acorn from "npm:acorn";

// overview of the plan:
//
//  - impl 1: as a naive ast interpreter, validated against test262
//      - vm state includes stack and heap
//      - stack identifies variable by names
//  - impl 2: bytecode interpreter, with coarse instructions

class AssertionError extends Error {}
function assert(value: boolean, msg?: string): asserts value {
  if (!value) {
    throw new AssertionError("assertion failed: " + msg);
  }
}

// deno-lint-ignore no-explicit-any
function assertIsValue(t: { type: string; value?: any }): asserts t is JSValue {
  if (t.type === "string") assert(t.value === "string");
  else if (t.type === "null") assert(t.value === undefined);
  else if (t.type === "undefined") assert(t.value === undefined);
  else if (t.type === "number") assert(t.value === "number");
  else if (t.type === "boolean") assert(t.value === "boolean");
  else if (t.type === "bigint") assert(t.value === "bigint");
  else if (t.type === "symbol") assert(t.value === "symbol");
  else throw new AssertionError("invalid JSValue");
}

class VMError extends Error {}

type JSValue =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
  | { type: "bigint"; value: bigint }
  | { type: "symbol"; value: symbol }
  | VMObject;

type PrimType = JSValue["type"];

interface Node extends acorn.Node {
  sourceFile?: string;
}

class ProgramException extends Error {
  context: string[];

  constructor(public exceptionValue: JSValue, context: Node[]) {
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

    assert(typeof message === "undefined" || typeof message === "string");
    super(
      "interpreted js program exception" +
        (message ? `: ${message}` : ""),
    );
    this.exceptionValue = exceptionValue;

    this.context = context.map((node: Node) => {
      assert(node.loc !== null);
      assert(node.loc !== undefined);
      assert(node.sourceFile !== undefined);
      const { loc: { start, end }, type } = node;
      const text = node.end - node.start <= 100
        ? node.sourceFile.slice(node.start, node.end)
        : "...";
      return `${type} - ${start.line}:${start.column}-${end.line}:${end.column} - ${text}`;
    });
  }
}

type Descriptor = {
  get?: VMInvokable;
  set?: VMInvokable;
  value?: JSValue;
  configurable: boolean;
  enumerable: boolean;
  writable: boolean;
};

type PropName = string | symbol;

interface VMRegExp extends VMObject {
  innerRE: RegExp;
}

class VMObject {
  readonly type: "object" | "function" = "object";
  descriptors: Map<PropName, Descriptor> = new Map();

  primitive?: boolean | string | number | bigint;
  innerRE?: RegExp;

  constructor(private _proto: VMObject | null = PROTO_OBJECT) {}

  resolveDescriptor(descriptor: Descriptor, vm?: VM) {
    if (descriptor.get !== undefined) {
      assert(vm instanceof VM, "looking up described value but vm not passed");
      const retVal = vm.performCall(descriptor.get, this, []);
      assert(typeof retVal.type === "string");
      return retVal;
    }
    return descriptor.value;
  }
  getOwnPropertyDescriptor(name: PropName): Descriptor | undefined {
    assert(typeof name === "string" || typeof name === "symbol");
    return this.descriptors.get(name);
  }
  getOwnPropertyNames(): IterableIterator<PropName> {
    return this.descriptors.keys();
  }
  getOwnProperty(name: PropName, vm = undefined): JSValue | undefined {
    assert(typeof name === "string" || typeof name === "symbol");

    const descriptor = this.getOwnPropertyDescriptor(name);
    if (descriptor === undefined) return undefined;

    return this.resolveDescriptor(descriptor, vm);
  }
  containsOwnProperty(name: PropName): boolean {
    assert(typeof name === "string" || typeof name === "symbol");
    return this.descriptors.has(name);
  }
  getProperty(name: PropName, vm?: VM): JSValue | undefined {
    assert(typeof name === "string" || typeof name === "symbol");

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
    assert(typeof name === "string" || typeof name === "symbol");
    assert(typeof value.type === "string");

    let descriptor;
    for (let obj: VMObject | null = <VMObject> this; obj; obj = obj.proto) {
      descriptor = obj.descriptors.get(name);
      if (descriptor !== undefined) {
        break;
      }
    }

    // TODO Honor writable, configurable, etc.
    if (descriptor === undefined) {
      assert(!this.descriptors.has(name));
      this.descriptors.set(name, {
        value,
        configurable: true,
        writable: true,
        enumerable: true,
      });
      return;
    }

    if (descriptor.set) {
      assert(vm instanceof VM, "looking up described value but vm not passed");
      return vm.performCall(descriptor.set, this, [value]);
    } else {
      descriptor.value = value;
    }
  }
  defineProperty(name: PropName, descriptor: Descriptor) {
    assert(typeof name === "string" || typeof name === "symbol");
    // descriptorValue is a VM value
    assert(
      typeof descriptor === "object",
      "VM bug: descriptor is not an object",
    );

    if (descriptor.get || descriptor.set) {
      for (const key of ["get", "set"]) {
        assert(key == "get" || key == "set");
        const val = descriptor[key];
        assert(
          val === undefined || val instanceof VMInvokable,
          `invalid descriptor: '${key}' is not a JS function nor undefined: ` +
            Deno.inspect(val),
        );
      }
    }

    for (const key of ["writable", "configurable", "enumerable"]) {
      assert(
        key === "writable" ||
          key === "configurable" ||
          key === "enumerable",
      );
      if (descriptor[key] === undefined) descriptor[key] = true;
      assert(
        typeof descriptor[key] === "boolean",
        `invalid descriptor: .${key} is not a boolean`,
      );
    }

    // TODO Propertly honor writable, configurable

    this.descriptors.set(name, descriptor);
  }
  deleteProperty(name: PropName): boolean {
    assert(typeof name === "string" || typeof name === "symbol");
    return this.descriptors.delete(name);
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
        assert(subject instanceof VMArray);
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
  name: string | null = null;

  constructor() {
    super(PROTO_FUNCTION);
    this.setProperty("prototype", new VMObject());
  }

  abstract run(vm: VM, subject: JSValue, args: JSValue[]): JSValue;

  invoke(vm: VM, subject: JSValue, args: JSValue[], options: InvokeOpts = {}) {
    // true iff this invocation comes from new Constructor(...)
    const isNew = options.isNew || false;
    assert(typeof isNew === "boolean");

    if (!isNew) {
      // do this substitution
      if (!this.isStrict) {
        console.log("this-substitution: not new, non strict");
        if (subject.type === "undefined" || subject.type === "null") {
          subject = vm.globalObj;
        }
        subject = vm.coerceToObject(subject);
      }
    }

    return vm.withScope(() => {
      assert(vm.currentScope !== null);

      vm.currentScope.isNew = isNew;
      vm.currentScope.this = subject;
      assert(this.isStrict || subject instanceof VMObject);
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
          assert(value !== undefined);
          vm.defineVar("var", name, value);
        }
      }

      const argumentsArray = new VMArray();
      argumentsArray.arrayElements.push(...args);

      vm.defineVar("var", "arguments", argumentsArray);

      // another scope, to allow redefinitions
      return vm.withScope(() => this.run(vm, subject, args));
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
    assert(outerInvokable instanceof VMInvokable);
    return outerInvokable.invoke(vm, forcedSubject, argsArray);
  }),
);
PROTO_FUNCTION.setProperty(
  "toString",
  nativeVMFunc((vm, subject, args) => {
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
    assert(typeof name === "string");
    const ret = subject.containsOwnProperty(name);
    assert(typeof ret === "boolean");
    return { type: "boolean", value: ret };
  }),
);

PROTO_ARRAY.setProperty(
  "push",
  nativeVMFunc((vm, subject, args) => {
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
    assert(subject instanceof VMArray);

    const sepValue = args[0] || { type: "string", value: "" };
    assert(sepValue.type === "string");
    assert(typeof sepValue.value === "string");

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
      assert(typeof subject.primitive === "string");
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
    assert(typeof ret === "boolean");
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
    assert(typeof str === "string");

    const nativeRet = subject.innerRE.exec(str);
    if (nativeRet === null) {
      return { type: "null" };
    }
    assert(nativeRet instanceof Array);

    const ret = new VMArray();
    for (const item of nativeRet) {
      assert(typeof item === "string");
      ret.arrayElements.push({ type: "string", value: item });
    }

    assert(typeof nativeRet.index === "number");
    ret.setProperty("index", { type: "number", value: nativeRet.index });

    assert(typeof nativeRet.input === "string");
    ret.setProperty("input", { type: "string", value: nativeRet.input });

    if (typeof nativeRet.groups !== "undefined") {
      assert(typeof nativeRet.groups === "object");
      assert(Object.getPrototypeOf(nativeRet.groups) === null);
      const groups = new VMObject();
      groups.proto = null;
      for (const groupName in nativeRet.groups) {
        const value = nativeRet.groups[groupName];
        assert(typeof value === "string");
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
  this: JSValue = { type: "undefined" };
  isCallWrapper = false;
  isSetStrict = false;

  parent: Scope | null = null;

  walkParents<T>(fn: (_: Scope) => T): T | null {
    let scope: Scope | null = this;
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
    let scope: Scope | null = this;
    while (scope.parent !== null) {
      scope = scope.parent;
    }
    return scope;
  }

  abstract defineVar(kind: DeclKind, name: string, value: JSValue): void;
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
  vars = new Map<string, JSValue>();
  dontDelete = new Set<string>();

  // true iff this scope is the function's wrapper
  //  - each function has at least 2 nested scopes:
  //     - wrapper: only arguments are defined
  //     - body: this corresponds to the function's body in { }
  // this allows us to allow var to redefine an argument in the function
  isCallWrapper = false;

  defineVar(kind: DeclKind, name: string, value: JSValue) {
    assertValidDeclKind(kind);

    // var decls bubble up to the top of the function's body
    if (kind === "var" && !this.isCallWrapper && this.parent !== null) {
      return this.parent.defineVar(kind, name, value);
    }

    assert(typeof name === "string", "var name must be string");

    if (this.vars.has(name)) {
      // redefinition, discard
      return;
    }

    this.vars.set(name, value);
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
    const value = this.vars.get(name);
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
    this.env.setProperty(name, value);
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
    if (this.dontDelete.has(name)) return false;
    return this.env.deleteProperty(name);
  }

  setDoNotDelete(name: string) {
    this.dontDelete.add(name);
  }
}

export class VM {
  globalObj = createGlobalObject();
  currentScope: Scope | null = null;
  synCtx: Node[] = [];
  synCtxError: string[] = [];

  //
  // VM state (variables, stack, heap, ...)
  //

  defineVar(kind: DeclKind, name: string, value: JSValue) {
    assert(this.currentScope !== null);
    return this.currentScope.defineVar(kind, name, value);
  }
  setVar(name: string, value: JSValue, _vm?: VM) {
    assert(this.currentScope !== null);
    return this.currentScope.setVar(name, value, this);
  }
  deleteVar(name: string) {
    assert(this.currentScope !== null);
    return this.currentScope.deleteVar(name);
  }
  lookupVar(name: string) {
    assert(this.currentScope !== null);
    return this.currentScope.lookupVar(name);
  }
  setDoNotDelete(name: string) {
    assert(this.currentScope !== null);
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
    assert(this.currentScope !== null);
    return this.currentScope.walkParents((scope) => {
      if (scope.isCallWrapper) return scope;
    });
  }

  #unsupportedNode(node: Node): never {
    throw new VMError("unsupported node: " + Deno.inspect(node));
  }

  #withSyntaxContext<T>(node: Node, inner: () => T): T {
    this.synCtxError = [];
    try {
      this.synCtx.push(node);
      return inner();
    } catch (err) {
      assert(node.loc !== null && node.loc !== undefined);
      assert(node.sourceFile !== undefined);
      this.synCtxError.push(
        `${node.type} ${node.loc.start.line}-${node.loc.end.line}`,
      );
      if (node.end - node.start <= 100) {
        const excerpt = node.sourceFile.slice(node.start, node.end);
        for (const line of excerpt.split("\n")) {
          this.synCtxError.push("  > " + line);
        }
      }

      throw err;
    } finally {
      const check = this.synCtx.pop();
      assert(check === node, "bug! syntax context manipulated");
    }
  }

  //
  // Statements
  //

  runScript({ text }: { path: string; text: string }) {
    const ast = acorn.parse(text, {
      ecmaVersion: "latest",
      directSourceFile: text,
      locations: true,
    });

    return this.runProgram(ast);
  }

  runProgram(node: acorn.Program) {
    assert(node.sourceType === "script", "only script is supported");
    assert(node.type === "Program", "must be called with a Program node");

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
        if (error instanceof ProgramException) {
          const excval = error.exceptionValue;
          const message = excval.type === "object"
            ? excval.getProperty("message")
            : excval;
          return {
            outcome: "error",
            message,
            error,
          };
        }

        if (this.synCtxError) {
          console.error("with syntax context:");
          for (const line of this.synCtxError) {
            console.error("|  " + line);
          }
          this.synCtxError = [];
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
      "you can only call a function (native or virtual), not " +
        Deno.inspect(callee),
    );
    return callee.invoke(this, subject, args);
  }

  #dispatch<T extends Node>(
    node: T,
    table: NodeDispatcher<T>,
  ): JSValue | undefined {
    return this.#withSyntaxContext(node, () => {
      const handler = table[node.type];
      if (handler) return handler.call(this, node);
      return this.#unsupportedNode(node);
    });
  }

  runStmt(node: acorn.Node): JSValue {
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
            );
            assert(
              stmt.handler.param.type === "Identifier",
              "only supported: catch clause param Identifier",
            );

            const paramName = stmt.handler.param.name;
            const body = stmt.handler.body;
            return this.withScope(() => {
              this.defineVar("var", paramName, err.exceptionValue);
              this.setDoNotDelete(paramName);
              return this.runStmt(body);
            });
          } else {
            // either pass the ProgramException to another of the program's try blocks
            // or pass the VMError to the VM caller
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
        throw new ProgramException(exceptionValue, [...this.synCtx]);
      }

      case "FunctionDeclaration":
        if (stmt.id.type === "Identifier") {
          const name = stmt.id.name;
          assert(!stmt.expression, "unsupported func decl type: expression");
          assert(!stmt.generator, "unsupported func decl type: generator");
          assert(!stmt.async, "unsupported func decl type: async");

          const func = this.makeFunction(stmt.params, stmt.body);
          assert(typeof name === "string");
          func.setProperty("name", { type: "string", value: name });
          this.defineVar("var", name, func);

          return func;
        } else {
          throw new VMError(
            "unsupported identifier for function declaration: " +
              Deno.inspect(stmt.id),
          );
        }

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
          throw new VMError("unsupported var decl type: " + stmt.kind);
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
            throw new VMError(
              "unsupported declarator id type: " + decl.id.type,
            );
          }
        }

        return completion;
      }

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
            completion = this.runStmt(stmt.body);
            if (stmt.update !== null && stmt.update !== undefined) {
              this.evalExpr(stmt.update);
            }
          }

          return completion;
        });

      case "ForInStatement": {
        const iteree = this.evalExpr(stmt.right);
        return this.withScope(() => {
          assert(
            stmt.left.type === "VariableDeclaration",
            "in for(...in...) statement: patterns not supported",
          );
          this.runStmt(stmt.left);

          assert(stmt.left.type === "VariableDeclaration");
          assert(stmt.left.declarations.length === 1);
          assert(stmt.left.declarations[0].type === "VariableDeclarator");
          assert(stmt.left.declarations[0].init === null);
          assert(stmt.left.declarations[0].id.type === "Identifier");
          const asmtTarget = stmt.left.declarations[0].id;

          assert(iteree instanceof VMObject);
          const properties = iteree.getOwnPropertyNames();
          for (const name of properties) {
            assert(typeof name === "string");
            const value = iteree.getOwnProperty(name);
            this.doAssignment(asmtTarget, value);
            this.runStmt(stmt.body);
          }

          return { type: "undefined" };
        });
      }
      default:
        throw new VMError("not a (supported) statement: " + stmt.type);
    }
  }

  //
  // Expressions
  //
  evalExpr(expr: acorn.Expression): JSValue {
    assert(this.currentScope !== null);

    switch (expr.type) {
      case "AssignmentExpression": {
        let value = this.evalExpr(expr.right);

        if (expr.operator === "=") {
          // no update
        } else if (expr.operator === "+=") {
          assert(
            expr.left.type === "Identifier" ||
              expr.left.type === "MemberExpression",
          );
          value = this.binExpr("+", expr.left, expr.right);
        } else {
          throw new VMError(
            "unsupported update assignment op. " + Deno.inspect(expr),
          );
        }

        return this.doAssignment(expr.left, value);
      }

      case "UpdateExpression": {
        const value = this.evalExpr(expr.argument);
        if (value.type !== "number") {
          this.throwTypeError(
            `update operation only support on numbers, not ${value.type}`,
          );
        }

        let newValue;
        if (expr.operator === "++") {
          newValue = { type: "number", value: value.value + 1 };
        } else if (expr.operator === "--") {
          newValue = { type: "number", value: value.value - 1 };
        } else {
          throw new VMError("unsupported update operator: " + expr.operator);
        }

        return this.doAssignment(expr.argument, newValue);
      }

      case "FunctionExpression": {
        assert(
          expr.id === null,
          "unsupported: function expression with non-null id: " + expr.id,
        );
        assert(!expr.expression, "unsupported: FunctionExpression.expression");
        assert(!expr.generator, "unsupported: FunctionExpression.generator");
        assert(!expr.async, "unsupported: FunctionExpression.async");

        return this.makeFunction(expr.params, expr.body);
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
          assert(propertyNode.computed === false, "node's computed === false");

          assert(propertyNode.key.type === "Identifier");
          const key = propertyNode.key.name;

          if (propertyNode.kind === "init") {
            const value = this.evalExpr(propertyNode.value);
            obj.setProperty(key, value);
          } else if (
            propertyNode.kind === "get" || propertyNode.kind === "set"
          ) {
            const func = this.evalExpr(propertyNode.value);
            if (!(func instanceof VMInvokable)) {
              throw new VMError(
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
            throw new VMError(
              "unsupported property kind: " + propertyNode.kind,
            );
          }
        }

        return obj;
      }

      case "ArrayExpression": {
        const elements = expr.elements.map((elmNode) => {
          assert(elmNode !== null);
          assert(elmNode.type !== "SpreadElement");
          return this.evalExpr(elmNode);
        });

        const arrayCons = this.globalObj.getProperty("Array");
        assert(arrayCons instanceof VMInvokable);
        const array = this.performNew(arrayCons, []);
        const pushMethod = array.getProperty("push");
        assert(pushMethod instanceof VMInvokable);
        for (const elm of elements) {
          this.performCall(pushMethod, array, [elm]);
        }

        return array;
      }

      case "MemberExpression": {
        assert(!expr.optional, "unsupported: MemberExpression.optional");

        assert(expr.object.type !== "Super");
        const object = this.coerceToObject(this.evalExpr(expr.object));

        let val;
        if (expr.computed) {
          assert(expr.property.type !== "PrivateIdentifier");
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
            assert(expr.argument.object.type !== "Super");
            const obj = this.evalExpr(expr.argument.object);
            if (!(obj instanceof VMObject)) {
              this.throwTypeError("can't delete from non-object");
            }

            let property;
            assert(expr.argument.property.type !== "PrivateIdentifier");
            if (expr.argument.computed) {
              const nameValue = this.evalExpr(expr.argument.property);
              if (nameValue.type !== "string") {
                this.throwTypeError("property type is not string");
              }
              property = nameValue.value;
            } else {
              assert(expr.argument.property.type === "Identifier");
              property = expr.argument.property.name;
            }

            const ret = obj.deleteProperty(property);
            return { type: "boolean", value: ret };
          } else {
            throw new VMError(
              "unsupported delete argument: " + Deno.inspect(expr),
            );
          }
        } else if (expr.operator === "typeof") {
          const value = this.evalExpr(expr.argument);
          return { type: "string", value: value.type };
        } else if (expr.operator === "!") {
          assert(expr.prefix === true, "only supported: expr.prefix === true");
          const value = this.coerceToBoolean(this.evalExpr(expr.argument));
          assert(typeof value === "boolean");
          return { type: "boolean", value: !value };
        } else if (expr.operator === "+") {
          const value = this.coerceNumeric(this.evalExpr(expr.argument));
          switch (value.type) {
            case "number":
              return { type: "number", value };
            case "bigint":
              return { type: "bigint", value };
            default:
              return { type: "undefined" };
          }
        } else if (expr.operator === "-") {
          const value = this.coerceNumeric(this.evalExpr(expr.argument));
          if (typeof value === "number") {
            return { type: "number", value: -value };
          }
          assert(typeof value === "bigint");
          return { type: "bigint", value: -value };
        } else if (expr.operator === "void") {
          // evaluate and discard
          this.evalExpr(expr.argument);
          return { type: "undefined" };
        } else {
          throw new VMError("unsupported unary op: " + expr.operator);
        }
      }

      case "BinaryExpression":
        assert(expr.left.type !== "PrivateIdentifier");
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
        } else {
          throw new VMError("unsupported logical op: " + expr.operator);
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
        const args = expr.arguments.map((argNode) => {
          assert(argNode.type !== "SpreadElement");
          return this.evalExpr(argNode);
        });
        assert(constructor instanceof VMInvokable);
        return this.performNew(constructor, args);
      }

      case "CallExpression": {
        const args = expr.arguments.map((argNode) => {
          assert(argNode.type !== "SpreadElement");
          return this.evalExpr(argNode);
        });
        let callThis: JSValue;
        let callee;

        if (
          expr.callee.type === "MemberExpression" &&
          expr.callee.property.type === "Identifier"
        ) {
          assert(
            !expr.callee.computed,
            "only supported: member call with !computed",
          );
          assert(
            !expr.callee.optional,
            "only supported: member call with !optional",
          );

          const name = expr.callee.property.name;

          assert(expr.callee.object.type !== "Super");
          callThis = this.evalExpr(expr.callee.object);
          callThis = this.coerceToObject(callThis);
          callee = callThis.getProperty(name);
          if (callee === undefined) {
            throw new VMError(
              `can't find method ${name} in ${Deno.inspect(callThis)}`,
            );
          }
        } else if (
          expr.callee.type === "Identifier" && expr.callee.name === "eval"
        ) {
          // don't lookup "eval" as a variable, perform "direct eval"

          if (expr.arguments.length === 0) {
            return { type: "undefined" };
          }

          assert(expr.arguments[0].type !== "SpreadElement");
          const arg = this.evalExpr(expr.arguments[0]);
          if (arg.type === "string") {
            return this.directEval(arg.value);
          } else {
            return arg;
          }
        } else {
          callThis = { type: "undefined" };
          assert(expr.callee.type !== "Super");
          callee = this.evalExpr(expr.callee);
          if (callee.type === "undefined" || callee.type === "null") {
            throw new VMError("can't invoke undefined/null");
          }
        }

        assert(callee instanceof VMInvokable);
        return this.performCall(callee, callThis, args);
      }

      case "ThisExpression": {
        for (
          let scope: Scope | null = this.currentScope;
          scope;
          scope = scope.parent
        ) {
          if (scope.this) {
            return scope.this;
          }
        }

        assert(this.currentScope !== null);

        const isStrict = this.currentScope.isStrict();
        return isStrict ? { type: "undefined" } : this.globalObj;
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

        if (expr.name === "arguments") {
          console.log('expression Identifier "arguments" resolved to:', value);
        }

        return value;
      }

      /** @this VM */
      case "Literal": {
        const value = expr.value;
        const type = typeof value;

        if (this.currentScope.isStrict()) {
          if (type === "number") {
            assert(expr.raw !== undefined);
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
        } else if (
          type === "number" || type === "string" || type === "boolean" ||
          type === "bigint"
        ) {
          assert(typeof value === type);
          return { type, value };
        } else if (type === "object" && expr.value instanceof RegExp) {
          return createRegExpFromNative(expr.value);
        } else {
          throw new VMError(
            `unsupported literal value: ${typeof expr.value} ${
              Deno.inspect(expr.value)
            }`,
          );
        }
      }
    }
  }

  binExpr(
    operator: string,
    left: acorn.Expression,
    right: acorn.Expression,
  ): JSValue {
    console.log(" ----- bin expr", operator);
    const stringToBigInt = (s: string) => {
      console.log("stringToBigInt, s =", s);

      try {
        const ret = BigInt(s);
        console.log("stringToBigInt, value =", ret);
        return ret;
      } catch (e) {
        console.log("stringToBigInt:", e);
        if (e instanceof SyntaxError) return undefined;
        console.log("stringToBigInt: rethrowing");
        throw e;
      }
    };
    const isLessThan = (a: JSValue, b: JSValue) => {
      // coercion of objects to primitives must be done by the caller,
      // where the proper evaluation order is known
      assert(!(a instanceof VMObject), "isLessThan: a must be primitive");
      assert(!(b instanceof VMObject), "isLessThan: b must be primitive");

      console.log("isLessThan", { a, b });

      if (a.type === "string" && b.type === "string") {
        // we could use the host JS's builtins, but we want to get
        // close to the spec for a future translation
        const limit = Math.min(a.value.length, b.value.length);
        for (let i = 0; i < limit; ++i) {
          const ac = a.value.codePointAt(i);
          assert(ac !== undefined);
          const bc = b.value.codePointAt(i);
          assert(bc !== undefined);
          if (ac < bc) return true;
          if (ac > bc) return false;
        }
        if (a.value.length < b.value.length) return true;
        return false;
      } else if (a.type === "bigint" && b.type === "string") {
        const bb = stringToBigInt(b.value);
        if (bb === undefined) return undefined;
        console.log("isLessThan: bigint/string:", {
          aa: a.value,
          bb,
        });
        assert(typeof a.value === "bigint");
        assert(typeof bb === "bigint");
        return a.value < bb;
      } else if (a.type === "string" && b.type === "bigint") {
        const aa = stringToBigInt(a.value);
        if (aa === undefined) return undefined;
        console.log("isLessThan: string/bigint:", {
          aa,
          bb: b.value,
        });
        assert(typeof aa === "bigint");
        assert(typeof b.value === "bigint");
        return aa < b.value;
      } else {
        console.log(`isLessThan: numeric (${a.type}/${b.type})`);
        const an = this.coerceNumeric(a);
        const bn = this.coerceNumeric(b);

        assert(typeof an === "number" || typeof an === "bigint");
        assert(typeof bn === "number" || typeof bn === "bigint");

        console.log("isLessThan: coerced numeric", { an, bn });

        if (Number.isNaN(an) || Number.isNaN(bn)) return undefined;
        console.log("bn =", bn);
        if (an === -Infinity) return (bn !== -Infinity);
        if (bn === +Infinity) return (an !== +Infinity);
        return an < bn;
      }
    };

    const arithmeticOp = (op: string, a: JSValue, b: JSValue): JSValue => {
      let a = this.coerceNumeric(a);
      let b = this.coerceNumeric(b);

      if (a.type === "number" && b.type === "number") {
        const res = op(a, b);
        assert(typeof res === "number");
        return { type: "number", value: res };
      } else if (a.type === "bigint" && b.type === "bigint") {
        const res = op(a, b);
        assert(typeof res === "bigint");
        return { type: "bigint", value: res };
      } else {
        this.throwError(
          "TypeError",
          `invalid operands for arithmetic operation: ${a.type}, ${b.type}`,
        );
      }
    };

    const numberOrStringOp = (implNumeric, implString) => {
      const a = this.evalExpr(left);
      const b = this.evalExpr(right);

      const ap = this.coerceToPrimitive(a, "valueOf first");
      const bp = this.coerceToPrimitive(b, "valueOf first");

      if (ap.type === "string" || bp.type === "string") {
        const as = this.coerceToString(ap);
        const bs = this.coerceToString(bp);
        assert(typeof as === "string", "invalid value (as)");
        assert(typeof bs === "string", "invalid value (bs)");

        const result = implString(as, bs);

        const rt = typeof result;
        assert(rt === "string" || rt === "boolean");
        return { type: rt, value: result };
      }

      let result;
      if (ap.type === "bigint" && bp.type === "string") {
        const bb = this.coerceToBigInt(bp);
        assert(typeof bb === "bigint");
        assert(typeof ap.value === "bigint");
        result = implNumeric(ap.value, bb);
      } else if (ap.type === "bigint" && bp.type === "string") {
        const ab = this.coerceToBigInt(ap);
        assert(typeof ab === "bigint");
        assert(typeof bp.value === "bigint");
        result = implNumeric(ab, bp.value);
      } else {
        const an = this.coerceNumeric(ap);
        const bn = this.coerceNumeric(bp);

        if (ap.type === bp.type) {
          assert(typeof an === "number" || typeof an === "bigint");
          assert(typeof bn === "number" || typeof bn === "bigint");
        }

        console.log(`>> operation on ${typeof an}:`, { an, bn });
        result = implNumeric(an, bn);
      }
      const rt = typeof result;
      assert(rt === "number" || rt === "bigint" || rt === "boolean");
      console.log(".. result = ", { rt, result });
      return { type: rt, value: result };
    };

    const isGreaterOrEqual = (a, b) => {
      const ret = isLessThan(a, b);
      console.log("isGreaterOrEqual: got from isLessThan:", ret);
      // if (ret === undefined) ret = undefined;
      console.log("isGreaterOrEqual =>", ret);
      if (typeof ret === "boolean") return !ret;
      assert(typeof ret === "undefined");
      return undefined;
    };

    const negateU = (x) => {
      if (typeof x === "boolean") return !x;
      return false; // undefined is always false
    };
    const wrapV = (x) => {
      assert(typeof x === "boolean");
      return { type: "boolean", value };
    };

    if (operator === "===") {
      const value = this.tripleEqual(left, right);
      assert(typeof value === "boolean");
      return { type: "boolean", value };
    } else if (operator === "!==") {
      const ret = this.tripleEqual(left, right);
      assert(typeof ret === "boolean");
      return { type: "boolean", value: !ret };
    } else if (operator === "==") {
      const ret = this.looseEqual(left, right);
      assert(
        typeof ret === "boolean",
        "looseEqual did not return boolean (==)",
      );
      return { type: "boolean", value: ret };
    } else if (operator === "!=") {
      const ret = this.looseEqual(left, right);
      assert(
        typeof ret === "boolean",
        "looseEqual did not return boolean (!=)",
      );
      return { type: "boolean", value: !ret };
    } else if (operator === "+") {
      return numberOrStringOp((a, b) => a + b, (a, b) => a + b);
    } else if (operator === "-") return arithmeticOp((a, b) => a - b);
    else if (operator === "*") return arithmeticOp((a, b) => a * b);
    else if (operator === "/") return arithmeticOp((a, b) => a / b);
    else if (operator === "<") {
      const a = this.coerceToPrimitive(this.evalExpr(left));
      const b = this.coerceToPrimitive(this.evalExpr(right));
      let ret = isLessThan(a, b);
      assert(typeof ret === "undefined" || typeof ret === "boolean");
      return { type: "boolean", value: Boolean(ret) };
    } else if (operator === "<=") {
      const a = this.coerceToPrimitive(this.evalExpr(left));
      const b = this.coerceToPrimitive(this.evalExpr(right));
      let ret = isLessThan(b, a);
      console.log("<=: isLessThan returned", ret);
      if (typeof ret === "boolean") ret = !ret;
      console.log("<=: negated:", ret);
      assert(typeof ret === "undefined" || typeof ret === "boolean");
      console.log("<=: returning:", Boolean(ret));
      return { type: "boolean", value: Boolean(ret) };
    } else if (operator === ">") {
      const a = this.coerceToPrimitive(this.evalExpr(left));
      const b = this.coerceToPrimitive(this.evalExpr(right));
      let ret = isLessThan(b, a);
      assert(typeof ret === "undefined" || typeof ret === "boolean");
      return { type: "boolean", value: Boolean(ret) };
    } else if (operator === ">=") {
      const a = this.coerceToPrimitive(this.evalExpr(left));
      const b = this.coerceToPrimitive(this.evalExpr(right));
      let ret = isLessThan(a, b);
      console.log(">=: isLessThan(a, b) returned", ret);
      if (typeof ret === "boolean") ret = !ret;
      console.log(">=: negated", ret);
      assert(typeof ret === "undefined" || typeof ret === "boolean");
      console.log(">=: returning", Boolean(ret));
      return { type: "boolean", value: Boolean(ret) };
    } else if (operator === "instanceof") {
      const constructor = this.evalExpr(right);
      let obj = this.evalExpr(left);
      for (; obj !== null; obj = obj.proto) {
        const check = obj.getProperty("constructor");
        if (!(check instanceof VMObject)) continue;
        if (check.is(constructor)) {
          return { type: "boolean", value: true };
        }
      }

      return { type: "boolean", value: false };
    } else throw new VMError("unsupported binary op: " + operator);
  }

  makeFunction(paramNodes, body, options = {}) {
    const params = paramNodes.map((paramNode) => {
      assert(
        paramNode.type === "Identifier",
        "unsupported: func params of type " + paramNode.type,
      );
      return paramNode.name;
    });

    assert(
      body.type === "BlockStatement",
      "only supported: BlockStatement as function body",
    );
    const func = new VMFunction(params, body);
    if (!options.scopeStrictnessIrrelevant && this.currentScope.isStrict()) {
      func.setStrict();
    }

    if (!func.isStrict && body.type === "BlockStatement") {
      const stmts = body.body;
      if (
        stmts.length > 0 &&
        stmts[0].type === "ExpressionStatement" &&
        stmts[0].directive === "use strict"
      ) {
        func.setStrict();
      }
    }

    return func;
  }

  isTruthy({ type, value }: JSValue) {
    if (type === "object") {
      throw new VMError("not yet implemented: isTruthy for object");
    }

    assert(
      typeof value === type,
      `bug: ${type} value does not have ${type} value, but ${typeof value}!`,
    );

    if (type === "boolean") return value;
    else if (type === "string") return value.length > 0;
    else if (type === "undefined") return false;
    else if (type === "number") {
      if (Number.isNaN(value)) return false;
      return value !== 0;
    }

    throw new VMError("not yet implemented: isTruthy: " + Deno.inspect(value));
  }

  performNew(constructor: VMInvokable, args: JSValue[]) {
    const initObj = new VMObject();

    let obj = constructor.invoke(this, initObj, args, { isNew: true });
    if (obj.type === "undefined") obj = initObj;

    assert(
      obj instanceof VMObject,
      "vm bug: invalid return type from constructor: " + Deno.inspect(obj),
    );
    obj.setProperty("constructor", constructor);
    obj.proto = this.coerceToObject(constructor.getProperty("prototype"));
    return obj;
  }

  doAssignment(targetExpr, value) {
    if (targetExpr.type === "MemberExpression") {
      assert(
        !targetExpr.optional,
        "unsupported: assignment to MemberExpression with .optional = true",
      );

      const obj = this.evalExpr(targetExpr.object);

      let property;
      if (targetExpr.computed) {
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
        if (!(property.type === "string" || property.type === "symbol")) {
          property = this.coerceToString(property);
        } else {
          property = property.value;
        }

        assert(
          typeof property === "string" || typeof property === "symbol",
          `property key should have been converted to string or symbol (instead it's ${typeof property})`,
        );

        obj.setProperty(property, value, this);
      }
    } else if (targetExpr.type === "Identifier") {
      const name = targetExpr.name;
      this.setVar(name, value);
    } else {
      throw new VMError(
        "unsupported assignment target: " + Deno.inspect(targetExpr),
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
      throw new VMError("exception constructor must be invokable");
    }
    const messageValue: JSValue = { type: "string", value: message };
    const exc = this.performNew(excCons, [messageValue]);
    throw new ProgramException(exc, this.synCtx);
  }

  coerceToObject(value: JSValue): VMObject {
    if (value instanceof VMObject) return value;

    // weird stupid case. why is BigInt not a constructor?
    if (value.type === "bigint") {
      console.log("wrapping bigint in BigInt object");
      const obj = new VMObject(PROTO_BIGINT);
      assert(typeof value.value === "bigint");
      obj.primitive = value.value;
      return obj;
    }

    const cons: JSValue | undefined = {
      number: this.globalObj.getProperty("Number"),
      boolean: this.globalObj.getProperty("Boolean"),
      string: this.globalObj.getProperty("String"),
      symbol: this.globalObj.getProperty("Symbol"),
      undefined: undefined,
      null: undefined,
    }[value.type];
    if (cons) {
      const obj = this.performNew(cons, [value]);
      assert(obj instanceof VMObject);
      return obj;
    }

    this.throwTypeError(
      "can't convert value to object: " + Deno.inspect(value),
    );
  }

  coerceToBoolean(value: JSValue) {
    let ret;

    if (value.type === "boolean") ret = value.value;
    else if (value.type === "undefined") ret = false;
    else if (value.type === "number") {
      // includes both +0 and -0
      ret = value.value !== 0 && !Number.isNaN(value.value);
    } else if (value.type === "bigint") ret = value.value !== 0n;
    else if (value.type === "string") ret = value.value !== "";
    else if (value.type === "symbol") ret = true;
    else if (value.type === "object") ret = !(value instanceof VMObject);
    else {
      this.throwTypeError(
        "can't convert value to boolean: " + Deno.inspect(value),
      );
    }

    assert(typeof ret === "boolean");
    return ret;
  }

  coerceToSymbol(value) {
    assert(value.type === typeof value.value);

    let ret;
    if (value.type === "symbol") ret = value.value;
    else if (value.type === "string") ret = Symbol(value.value);
    else this.throwTypeError(`can't convert ${value.type} to symbol`);

    assert(typeof ret === "symbol");
    return ret;
  }

  tripleEqual(leftExpr, rightExpr) {
    const left = this.evalExpr(leftExpr);
    const right = this.evalExpr(rightExpr);

    if (left.type !== right.type) {
      return false;
    }

    const t = left.type;

    let value;
    if (left instanceof VMObject) {
      value = Object.is(left, right);
    } else if (t === "null") value = right.type === "null";
    else if (t === "boolean") value = left.value === right.value;
    else if (t === "string") value = left.value === right.value;
    else if (t === "number") value = left.value === right.value;
    else if (t === "bigint") value = left.value === right.value;
    else if (t === "symbol") value = left.value === right.value;
    else if (t === "undefined") value = true;
    else throw new VMError("invalid value type: " + t);

    assert(typeof value === "boolean");
    return value;
  }

  looseEqual(left, right) {
    left = this.evalExpr(left);
    right = this.evalExpr(right);
    return this._looseEqual(left, right);
  }
  _looseEqual(left, right) {
    console.log(" ---- loose equal");

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

    let counter = 0;
    while (true) {
      console.log("loop:", {
        counter: ++counter,
        left,
        right,
      });
      assert((left.type === "object") === (left instanceof VMObject));
      assert(
        left instanceof VMObject || left.type === "null" ||
          left.type === typeof left.value,
      );
      assert((right.type === "object") === (right instanceof VMObject));
      assert(
        right instanceof VMObject || right.type === "null" ||
          right.type === typeof right.value,
        `invalid right value: ${right.type} / ${typeof right.value}`,
      );

      if (left.type === right.type) {
        console.log(" >> same type");
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
        ) result = left.value === right.value;
        else throw new AssertionError("invalid value type: " + left.type);

        assert(typeof result === "boolean");
        return result;
      }

      const leftIsUN = left.type === "undefined" || left.type === "null";
      const rightIsUN = right.type === "undefined" || right.type === "null";
      if (leftIsUN || rightIsUN) {
        return leftIsUN && rightIsUN;
      }

      if (left instanceof VMObject && !(right instanceof VMObject)) {
        left = this.coerceToPrimitive(left);
        console.log(" >> coerced left to primitive;", left);
        continue;
      }
      if (!(left instanceof VMObject) && right instanceof VMObject) {
        right = this.coerceToPrimitive(right);
        console.log(" >> coerced right to primitive;", right);
        continue;
      }

      assert(left.type !== "object");
      assert(right.type !== "object");

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
        const value = left.value == right.value;
        assert(typeof value === "boolean");
        return value;
      } // String to BigInt: convert the string to a BigInt using the
      // same algorithm as the BigInt() constructor. If conversion
      // fails, return false.
      else if (left.type === "string" && right.type === "bigint") {
        const value = this.coerceToBigInt(left);
        if (typeof value === "undefined") return false;
        assert(typeof value === "bigint");
        left = { type: "bigint", value };
        continue;
      } else if (left.type === "bigint" && right.type === "string") {
        const value = this.coerceToBigInt(right);
        if (typeof value === "undefined") return false;
        assert(typeof value === "bigint");
        right = { type: "bigint", value };
        continue;
      }

      assert(false, "unreachable!");
    }
  }

  coerceToPrimitive(value, order = "valueOf first") {
    if (value instanceof VMObject) {
      const symToPrimitive = this.globalObj.getProperty("Symbol").getProperty(
        "toPrimitive",
      );
      assert(symToPrimitive.type === "symbol");
      assert(typeof symToPrimitive.value === "symbol");

      let prim;

      const tryCall = (methodName, args) => {
        if (prim !== undefined) return;

        const method = value.getProperty(methodName);
        if (method instanceof VMInvokable) {
          console.log(`invoking object's ${methodName.toString()}`);
          const ret = method.invoke(this, value, args);
          // primitive: can be used
          if (ret.type !== "object" && ret.type !== "undefined") {
            prim = ret;
          }
        } else {
          console.log(`object has no method named ${methodName.toString()}`);
        }
      };

      tryCall(symToPrimitive.value, [{ type: "string", value: "default" }]);
      if (order === "valueOf first") {
        tryCall("valueOf", []);
        tryCall("toString", []);
      } else if (order === "toString first") {
        tryCall("toString", []);
        tryCall("valueOf", []);
      } else throw new VMError('invalid value for arg "order": ' + order);

      if (prim !== undefined) return prim;
      else {this.throwError(
          "TypeError",
          "value can't be converted to a primitive",
        );}
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

    assert(typeof value.value === value.type);
    if (value.type === "number") return value.value;
    if (value.type === "undefined") return NaN;
    if (value.type === "boolean") return value.value ? 1 : 0;
    if (value.type === "string") return +value.value;
    if (value.type === "bigint") return Number(value.value);
    if (value.type === "symbol") {
      this.throwTypeError("can't convert symbol to number");
    }
    if (value instanceof VMObject) {
      return this.coerceToNumber(this.coerceToPrimitive(value));
    }
    throw new AssertionError("unreachable code!");
  }
  coerceNumeric(value: JSValue): number | bigint {
    if (value.type === "number" || value.type === "bigint") {
      return value.value;
    }
    return this.coerceToNumber(value);
  }
  coerceToBigInt(value: JSValue): bigint {
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
    else {throw new AssertionError(
        "unreachable! invalid value type: " + value.type,
      );}

    assert(typeof ret === "bigint" || typeof ret === "undefined");
    return ret;
  }

  coerceToString(value) {
    if (value instanceof VMObject) {
      // Objects are first converted to a primitive by calling its [Symbol.toPrimitive]() (with "string" as hint), toString(), and valueOf() methods, in that order. The resulting primitive is then converted to a string.
      const prim = this.coerceToPrimitive(value, "toString first");
      if (prim.type === "undefined") {
        throw new VMError(
          "VM bug: object could not be converted to string (at least Object.prototype.toString should have been called)",
        );
      }

      assert(prim.type !== "object");
      return this.coerceToString(prim);
    }

    let str;
    if (value.type === "null") str = "null";
    else {
      assert(
        value.type === typeof value.value,
        `VM bug: invalid primitive value: ${value.type} / ${typeof value
          .value}`,
      );
      if (value.type === "string") str = value.value;
      else if (value.type === "undefined") str = "undefined";
      else if (value.type === "boolean") str = value.value ? "true" : "false";
      else if (value.type === "number") {
        str = Number.prototype.toString.call(value.value);
      } else if (value.type === "bigint") {
        str = BigInt.prototype.toString.call(value.value);
      } else if (value.type === "symbol") str = value.value;
      else throw new VMError("invalid value type: " + value.type);
    }

    assert(typeof str === "string");
    return str;
  }
}

type NodeDispatcher<T extends Node> = {
  [nodeType: string]: (
    this: VM,
    _: T & { type: T["type"] },
  ) => JSValue | undefined;
};

type NativeFunc = (vm: VM, subject: JSValue, args: JSValue[]) => JSValue;

function nativeVMFunc(innerImpl: NativeFunc): VMInvokable {
  return new class extends VMInvokable {
    // in innerImpl, `this` is the VMInvokable object
    run = innerImpl;
  }();
}

function assertIsVMRegExp(vm: VM, obj: JSValue): asserts obj is VMRegExp {
  assertIsObject(vm, obj);
  if (obj.innerRE === undefined) {
    return vm.throwError("TypeError", "expected a RegExp!");
  }
}

function createRegExpFromNative(vm: VM, innerRE: RegExp): VMRegExp {
  assert(innerRE instanceof RegExp);
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
      assert(typeof arg.value === "number");
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
  });
  G.setProperty("Error", consError);
  consError
    .getProperty("prototype")
    .setProperty("name", { type: "string", value: "Error" });

  function createSimpleErrorType(name) {
    const Error = G.getOwnProperty("Error");
    const parentProto = Error.getProperty("prototype");
    const proto = new VMObject(parentProto);
    proto.setProperty("name", { type: "string", value: name });

    G.setProperty(
      name,
      new class extends VMInvokable {
        constructor() {
          super(proto);
        }
        invoke(vm, subject, args) {
          return Error.invoke(vm, subject, args);
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
    assert(typeof vm.currentCallWrapper.isNew === "boolean");
    if (vm.currentCallWrapper.isNew) {
      // when called via new, subject is already a freshly created object. sufficient to be returned from this constructor
      return subject;
    }

    let arg = args[0] || { type: "undefined" };
    if (arg.type === "undefined" || arg.type === "null") {
      return new VMObject();
    }

    return vm.coerceToObject(arg);
  });
  consObject.setProperty("prototype", PROTO_OBJECT);
  consObject.setProperty(
    "defineProperty",
    nativeVMFunc((vm, subject, args) => {
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
      if (!(descriptor instanceof VMObject)) {
        return vm.throwTypeError(
          "Object.defineProperty: third argument must be object",
        );
      }

      assert(typeof name.value === "string");
      // descriptorValue is a VM value
      if (descriptor.type !== "object") {
        return vm.throwError("TypeError", "invalid descriptor: not an object");
      }

      let getter, setter;
      if (
        descriptor.containsOwnProperty("get") ||
        descriptor.containsOwnProperty("set")
      ) {
        function checkFunc(key) {
          const value = descriptor.getProperty(key);
          if (
            !(value === undefined || value.type === "undefined" ||
              value instanceof VMInvokable)
          ) {
            return vm.throwError(
              "TypeError",
              `invalid descriptor: '${key}' is not a function`,
            );
          }
          return value;
        }

        getter = checkFunc("get");
        setter = checkFunc("set");
      }

      function parseBool(key) {
        const value = descriptor.getProperty("writable");
        if (value.type === "undefined") return true;
        if (value.type === "boolean") {
          return vm.throwError(
            "TypeError",
            "invalid descriptor: `writable` is not a boolean",
          );
        }
        return value.value;
      }

      const writable = parseBool("writable");
      const configurable = parseBool("configurable");

      obj.defineProperty(name.value, {
        get: getter,
        set: setter,
        value: descriptor.getProperty("value"),
        writable,
        configurable,
      });
      return { type: "undefined" };
    }),
  );
  consObject.setProperty(
    "getOwnPropertyDescriptor",
    nativeVMFunc((vm, subject, args) => {
      /** @type VMObject */
      const obj = vm.coerceToObject(args[0] || { type: "undefined" });
      const name = args[1];
      if (name === undefined || name.type === "undefined") {
        return { type: "undefined" };
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
    nativeVMFunc((vm, subject, args) => {
      /** @type VMObject */
      const obj = vm.coerceToObject(args[0] || { type: "undefined" });
      const names = obj.getOwnPropertyNames();
      const ret = new VMArray();
      for (const name of names) {
        assert(typeof name === "string");
        ret.arrayElements.push({ type: "string", value: name });
      }
      return ret;
    }),
  );
  G.setProperty("Object", consObject);

  function wrapPrimitive(subject, value, coercer, primType, prototype) {
    const prim = coercer(value);
    assert(
      typeof prim === primType,
      `coercer returned <${typeof prim}>, expected <${primType}>`,
    );
    if (subject instanceof VMObject) {
      subject = new VMObject(prototype);
      subject.primitive = prim;
      return subject;
    }
    return { type: primType, value: prim };
  }

  function addPrimitiveWrapperConstructor(
    name,
    prototype,
    primType,
    coercerName,
  ) {
    const cons = nativeVMFunc((vm, subject, args) => {
      const arg = args[0] === undefined ? { type: "undefined" } : args[0];
      const prim = vm[coercerName](arg);
      assert(
        typeof prim === primType,
        `coercer returned <${typeof prim}>, expected <${primType}>`,
      );

      if (subject instanceof VMObject) {
        subject = new VMObject(prototype);
        subject.primitive = prim;
        return subject;
      }
      return { type: primType, value: prim };
    });

    G.setProperty(name, cons);
    cons.setProperty("prototype", prototype);
    return cons;
  }

  const consBoolean = addPrimitiveWrapperConstructor(
    "Boolean",
    PROTO_BOOLEAN,
    "boolean",
    "coerceToBoolean",
  );

  const consNumber = addPrimitiveWrapperConstructor(
    "Number",
    PROTO_NUMBER,
    "number",
    "coerceToNumber",
  );
  consNumber.setProperty("POSITIVE_INFINITY", {
    type: "number",
    value: Infinity,
  });
  consNumber.setProperty("NEGATIVE_INFINITY", {
    type: "number",
    value: -Infinity,
  });
  consNumber.setProperty("NaN", { type: "number", value: NaN });
  consNumber.setProperty("MIN_VALUE", {
    type: "number",
    value: Number.MIN_VALUE,
  });
  consNumber.setProperty("MAX_VALUE", {
    type: "number",
    value: Number.MAX_VALUE,
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
      assert(typeof value === "bigint");
      return { type: "bigint", value };
    }),
  );

  const consString = addPrimitiveWrapperConstructor(
    "String",
    PROTO_STRING,
    "string",
    "coerceToString",
  );
  consString.setProperty(
    "fromCharCode",
    nativeVMFunc((vm, subject, args) => {
      const arg = args[0];
      if (arg === undefined || arg.type === "undefined") {
        return { type: "string", value: "" };
      }

      if (arg.type !== "number") {
        return vm.throwTypeError(
          "String.fromCharCode requires a numeric code point, not " + arg.type,
        );
      }

      const ret = String.fromCharCode(arg.value);
      assert(typeof ret === "string");
      return { type: "string", value: ret };
    }),
  );

  const consSymbol = addPrimitiveWrapperConstructor(
    "Symbol",
    PROTO_SYMBOL,
    "symbol",
    "coerceToSymbol",
  );
  // we import some well-known symbols from the host JS
  // TODO stop doing this; define our own Symbol representation and our own well-defined symbols
  consSymbol.setProperty("toPrimitive", {
    type: "symbol",
    value: Symbol.toPrimitive,
  });

  const consArray = nativeVMFunc((vm, subject, args) => {
    assert(
      subject.type === "object",
      "Only supported invoking via new Array()",
    );
    return new VMArray();
  });
  G.setProperty("Array", consArray);
  consArray.setProperty(
    "isArray",
    nativeVMFunc((vm, subject, args) => {
      const value = subject instanceof VMArray;
      assert(typeof value === "boolean");
      return { type: "boolean", value };
    }),
  );
  consArray.setProperty("prototype", PROTO_ARRAY);

  const consFunction = nativeVMFunc((vm, subject, args) => {
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
      directSourceFile: new SourceWrapper(text),
      locations: true,
    });
    assert(ast.type === "Program");
    ast.type = "BlockStatement";
    return vm.makeFunction([], ast, { scopeStrictnessIrrelevant: true });
  });
  G.setProperty("Function", consFunction);
  consFunction.setProperty("prototype", PROTO_FUNCTION);

  const consRegExp = nativeVMFunc((vm, subject, args) => {
    const arg = args[0];
    if (arg.type !== "string") {
      return vm.throwTypeError("RegExp constructor argument must be string");
    }
    return createRegExpFromNative(new RegExp(arg.value));
  });
  G.setProperty("RegExp", consRegExp);
  consRegExp.setProperty("prototype", PROTO_REGEXP);

  G.setProperty(
    "eval",
    nativeVMFunc((vm, subject, args) => {
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
      let savedScope = vm.currentScope;
      let rootScope = vm.currentScope.getRoot();
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
        assert(savedScope instanceof Scope);
        vm.currentScope = savedScope;
      }
    }),
  );

  G.setProperty(
    "nativeHello",
    nativeVMFunc((vm, subject, args) => {
      console.log("hello world!");
      return { type: "undefined" };
    }),
  );

  G.setProperty(
    "$print",
    nativeVMFunc((vm, subject, args) => {
      for (const arg of args) {
        const prim = vm.coerceToPrimitive(arg);
        console.log(prim);
      }
      return { type: "undefined" };
    }),
  );

  for (const name of G.getOwnPropertyNames()) {
    const value = G.getOwnProperty(name);

    if (typeof name === "string" && value instanceof VMInvokable) {
      // value is a constructor
      value.name = name;

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

// vim:ts=4:sts=0:sw=0:et
