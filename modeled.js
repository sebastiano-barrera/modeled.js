import * as acorn from 'npm:acorn';

// overview of the plan:
//
//  - impl 1: as a naive ast interpreter, validated against test262
//      - vm state includes stack and heap
//      - stack identifies variable by names
//  - impl 2: bytecode interpreter, with coarse instructions

class AssertionError extends Error { }
function assert(value, msg) {
    if (!value) {
        throw new AssertionError('assertion failed: ' + msg);
    }
}


class VMError extends Error { }

class ProgramException extends Error {
    constructor(exceptionValue, context) {
        super('interpreted js program exception');
        this.exceptionValue = exceptionValue;

        this.context = context.map(node => {
            const { loc: { start, end }, type } = node
            const text
                = node.end - node.start <= 100
                    ? node.sourceFile.getRange(node.start, node.end)
                    : '...';
            return `${type} - ${start.line}:${start.column}-${end.line}:${end.column} - ${text}`
        });
    }
}

class ObjectError extends Error { }

class VMObject {
    #proto = null
    type = 'object'

    constructor(proto = PROTO_OBJECT) {
        this.descriptors = new Map()
        this._proto = proto
    }

    resolveDescriptor(descriptor, vm) {
        if (descriptor.get) {
            assert(vm instanceof VM, "looking up described value but vm not passed");
            const retVal = vm.performCall(descriptor.get, this, []);
            assert(typeof retVal.type === 'string');
            return retVal;
        }
        return descriptor.value;
    }
    getOwnPropertyDescriptor(name) { return this.descriptors.get(name); }
    getOwnPropertyNames() { return this.descriptors.keys() }
    getOwnProperty(name, vm = undefined) {
        assert(typeof name === 'string');

        const descriptor = this.getOwnPropertyDescriptor(name);
        if (descriptor === undefined) return { type: 'undefined' };

        return this.resolveDescriptor(descriptor, vm);
    }
    hasOwnProperty(name) {
        assert(typeof name === 'string');
        return this.descriptors.has(name);
    }
    getProperty(name, vm = undefined) {
        assert(typeof name === 'string');

        let object = this;
        while (object !== null) {
            let value = object.getOwnProperty(name, vm);
            if (value.type !== 'undefined') {
                return value;
            }
            object = object.proto;
        }

        return { type: 'undefined' };
    }
    setProperty(name, value, vm) {
        assert(typeof name === 'string');
        assert(typeof value.type === 'string');

        let descriptor;
        for (let obj = this; obj; obj = obj.proto) {
            descriptor = obj.descriptors.get(name);
            if (descriptor !== undefined)
                break;
        }

        // TODO Honor writable, configurable, etc.
        if (descriptor === undefined) {
            assert(!this.descriptors.has(name));
            return this.descriptors.set(name, {
                value,
                configurable: true,
                writable: true,
                enumerable: true,
            })
        }

        if (descriptor.set) {
            assert(vm instanceof VM, "looking up described value but vm not passed");
            return vm.performCall(descriptor.set, this, [value]);
        } else {
            descriptor.value = value;
        }
    }
    defineProperty(name, descriptor) {
        assert(typeof name === 'string');
        // descriptorValue is a VM value
        assert(typeof descriptor === 'object', 'VM bug: descriptor is not an object')

        if (descriptor.get || descriptor.set) {
            assert(
                descriptor.get === undefined || descriptor.get instanceof VMInvokable,
                'invalid descriptor: `get` is not a function'
            );
            assert(
                descriptor.set === undefined || descriptor.set instanceof VMInvokable,
                'invalid descriptor: `set` is not a function'
            );
        }

        for (const key of ['writable', 'configurable', 'enumerable']) {
            if (descriptor[key] === undefined) descriptor[key] = true;
            assert(typeof descriptor[key] === 'boolean', `invalid descriptor: .${key} is not a boolean`);
        }

        // TODO Propertly honor writable, configurable

        this.descriptors.set(name, descriptor);
    }
    deleteProperty(name) {
        assert(typeof name === 'string');
        return this.descriptors.delete(name);
    }

    getIndex(index) { return this.getOwnProperty(String(index)); }
    setIndex(index, value) { return this.setProperty(String(index), value); }

    get proto() { return this._proto }
    set proto(newProto) {
        assert(newProto === null || newProto instanceof VMObject, "VMObject's prototype must be VMObject or null");
        this._proto = newProto;
    }

    is(other) {
        // we reuse the host JS VM logic for now
        return Object.is(this, other);
    }
}

class VMArray extends VMObject {
    constructor() {
        super(PROTO_ARRAY);
        this.arrayElements = []
    }

    getOwnProperty(name, vm = undefined) {
        if (name === 'length')
            return { type: 'number', value: this.arrayElements.length };
        return super.getOwnProperty(name, vm);
    }

    getIndex(index) {
        return typeof index === 'number'
            ? this.arrayElements[index]
            : super.getIndex(index);
    }

    setIndex(index, value) {
        if (typeof index === 'number') this.arrayElements[index] = value;
        else return super.setIndex(index, value);
    }
}

const PROTO_OBJECT = new VMObject(null)
const PROTO_FUNCTION = new VMObject(PROTO_OBJECT)
const PROTO_NUMBER = new VMObject()
const PROTO_BOOLEAN = new VMObject()
const PROTO_STRING = new VMObject()
const PROTO_ARRAY = new VMObject()
const PROTO_REGEXP = new VMObject();

class VMInvokable extends VMObject {
    type = 'function'

    constructor() {
        super(PROTO_FUNCTION);
        this.setProperty('prototype', new VMObject());
    }

    invoke() { throw new AssertionError('invoke not implemented'); }
}

PROTO_FUNCTION.setProperty('bind', nativeVMFunc((vm, outerInvokable, args) => {
    const forcedSubject = args[0];
    return nativeVMFunc((vm, _, args) => {
        // force subject to be this inner subject passed here
        return outerInvokable.invoke(vm, forcedSubject, args)
    })
}))
PROTO_FUNCTION.setProperty('call', nativeVMFunc((vm, outerInvokable, args) => {
    const forcedSubject = args.length >= 1 ? args[0] : { type: 'undefined' };
    // force subject to be this inner subject passed here
    return outerInvokable.invoke(vm, forcedSubject, args.slice(1))
}))
PROTO_FUNCTION.setProperty('apply', nativeVMFunc((vm, outerInvokable, args) => {
    const forcedSubject = args.length >= 1 ? args[0] : { type: 'undefined' };
    const argsArray = args.length >= 2 ? args[1] : { type: 'undefined' };
    // force subject to be this inner subject passed here
    return outerInvokable.invoke(vm, forcedSubject, argsArray)
}))

PROTO_OBJECT.setProperty('toString', nativeVMFunc(() => ({ type: 'string', value: '[object Object]' })));
PROTO_OBJECT.setProperty('hasOwnProperty', nativeVMFunc((vm, subject, args) => {
    subject = vm.coerceToObject(subject);
    const name = vm.coerceToString(args[0] || { type: 'undefined' });
    assert(name.type === 'string');
    const ret = subject.hasOwnProperty(name.value);
    assert(typeof ret === 'boolean');
    return { type: 'boolean', value: ret };
}));

PROTO_ARRAY.setProperty('push', nativeVMFunc((vm, subject, args) => {
    assert(subject instanceof VMArray, "`this` must be an array");

    if (typeof args[0] !== 'undefined')
        subject.arrayElements.push(args[0])
    return { type: 'undefined' };
}));
PROTO_ARRAY.setProperty('join', nativeVMFunc((vm, subject, args) => {
    if (!(subject instanceof VMArray))
        vm.throwTypeError("Array.prototype.join must be called on an Array");

    const sepValue = args[0] || { type: 'string', value: '' };
    assert(sepValue.type === 'string');
    assert(typeof sepValue.value === 'string');

    const retStr = subject.arrayElements.map(value => {
        const str = vm.coerceToString(value);
        assert(str.type === 'string');
        return str.value;
    }).join(sepValue.value);
    return { type: 'string', value: retStr };
}));


class VMFunction extends VMInvokable {
    #isStrict = false;

    constructor(params, body) {
        super();
        this.params = params;
        this.body = body;
        this.parentScope = null;
        this.name = null;
    }

    get isStrict() { return this.#isStrict; }
    setStrict() { this.#isStrict = true; }

    invoke(vm, subject, args) {
        // do this substitution
        if (!this.isStrict) {
            if (subject.type === 'undefined' || (subject.type === 'object' && subject.value === null))
                subject = vm.globalObj;
            subject = vm.coerceToObject(subject);
        }

        return vm.withScope(() => {
            vm.currentScope.this = subject;
            assert(this.isStrict || subject instanceof VMObject);
            vm.currentScope.isCallWrapper = true;
            vm.currentScope.isSetStrict = this.isStrict;

            const argumentsArray = new VMArray()

            for (const ndx in this.params) {
                const name = this.params[ndx];
                const value = args[ndx] || { type: 'undefined' };
                vm.defineVar('var', name, value);
                argumentsArray.arrayElements.push(value);
            }

            vm.defineVar('var', 'arguments', argumentsArray);

            return vm.withScope(() => {
                try { vm.runStmt(this.body) }
                catch (e) {
                    if (e.returnValue) {
                        assert(typeof e.returnValue.type === 'string', "return value uninitialized!");
                        return e.returnValue;
                    }
                    throw e;
                }

                return { type: "undefined" }
            })
        })
    }
}


PROTO_STRING.setProperty('replace', nativeVMFunc((vm, subject, args) => {
    if (typeof subject.primitive !== 'string')
        vm.throwTypeError('String.prototype.replace must be called on a string primitive');
    if (args[0].type !== 'string')
        vm.throwTypeError('String.prototype.replace: first argument must be string');

    let retStr;
    if (args[1].type === 'string') {
        retStr = subject.primitive.replace(args[0].value, args[1].value);
    } else if (args[1] instanceof VMInvokable) {
        retStr = subject.primitive.replace(args[0].value, () => {
            const ret = vm.performCall(args[1], { type: 'undefined' }, [args[0]]);
            if (ret.type !== 'string')
                vm.throwTypeError('invalid return value from passed function: ' + ret.type);
            return ret.value;
        });
    } else {
        vm.throwTypeError('String.prototype.replace: invalid type for argument #2: ' + args[1].type)
    }

    return { type: 'string', value: retStr };
}))


PROTO_NUMBER.setProperty('toString', nativeVMFunc((vm, subject, args) => {
    if (subject.type !== 'number')
        vm.throwTypeError('Number.prototype.toString must be called on number');

    assert(typeof subject.value === 'number');
    return Number.prototype.toString.call(subject.value);
}))

PROTO_REGEXP.setProperty('test', nativeVMFunc((vm, subject, args) => {
    const arg = args[0]
    if (arg.type !== 'string') {
        vm.throwTypeError('RegExp.test argument must be string')
    }

    const ret = subject.innerRE.test(arg.value)
    assert(typeof ret === 'boolean')
    return { type: 'boolean', value: ret }
}));
PROTO_REGEXP.setProperty('exec', nativeVMFunc((vm, subject, args) => {
    assert(
        subject.innerRE instanceof RegExp,
        "RegExp.prototype.exec can only be called on RegExp objects"
    );

    if (args.length === 0 || args[0].type !== 'string')
        vm.throwTypeError("RegExp.prototype.exec must be called with a single string as argument");

    const str = args[0].value;
    assert(typeof str === 'string');

    const nativeRet = subject.innerRE.exec(str);
    if (nativeRet === null)
        return { type: "object", value: null };
    assert(nativeRet instanceof Array);

    const ret = new VMArray();
    for (const item of nativeRet) {
        assert(typeof item === 'string');
        ret.arrayElements.push({ type: 'string', value: item });
    }

    assert(typeof nativeRet.index === 'number');
    ret.setProperty('index', { type: 'number', value: nativeRet.index });

    assert(typeof nativeRet.input === 'string');
    ret.setProperty('input', { type: 'string', value: nativeRet.input });

    if (typeof nativeRet.groups !== 'undefined') {
        assert(typeof nativeRet.groups === 'object');
        assert(Object.getPrototypeOf(nativeRet.groups) === null);
        const groups = new VMObject();
        groups.proto = { type: 'object', value: 'null' };
        for (const groupName in nativeRet.groups) {
            const value = nativeRet.groups[groupName];
            assert(typeof value === 'string');
            groups.setProperty(groupName, { type: 'string', value });
        }

        ret.setProperty('groups', groups);
    }

    // TODO property `indices`
    return ret;
}));

class Scope {
    constructor() {
        if (this.constructor === Scope) throw 'no!';
        this.parent = null
        this.isSetStrict = false
    }

    walkParents(fn) {
        let scope = this;
        while (scope !== null) {
            const ret = fn(scope);
            if (typeof ret !== 'undefined')
                return ret;
            scope = scope.parent;
        }
    }

    isStrict() {
        return this.walkParents(scope => {
            if (scope.isSetStrict) return true;
        }) || false
    }

    getRoot() {
        let scope = this;
        while (scope.parent !== null)
            scope = scope.parent;
        return scope;
    }
}

class VarScope extends Scope {
    constructor() {
        super();
        this.vars = new Map();
        this.dontDelete = new Set();
        // true iff this scope is the function's wrapper
        //  - each function has at least 2 nested scopes:
        //     - wrapper: only arguments are defined
        //     - body: this corresponds to the function's body in { }
        // this allows us to allow var to redefine an argument in the function
        this.isCallWrapper = false;
    }

    defineVar(kind, name, value) {
        // var decls bubble up to the top of the function's body
        if (kind === 'var' && !this.isCallWrapper) {
            return this.parent.defineVar(kind, name, value);
        }

        assert(
            kind === 'var' || kind === 'let' || kind === 'const',
            "`kind` must be one of 'var', 'let', or 'const'"
        );
        assert(typeof name === 'string', 'var name must be string');

        if (this.vars.has(name)) {
            // redefinition, discard
            return;
        }

        this.vars.set(name, value);
    }

    setVar(name, value) {
        if (this.vars.has(name)) this.vars.set(name, value);
        else if (this.parent) this.parent.setVar(name, value);
        else {
            const exc = new VMObject();
            exc.setProperty('name', { type: 'string', value: 'NameError' });
            exc.setProperty('message', { type: 'string', value: 'unbound variable: ' + name })
            throw new ProgramException(exc, [...this.synCtx]);
        }
    }

    lookupVar(name) {
        const value = this.vars.get(name);
        if (typeof value !== 'undefined') return value;
        if (this.parent) return this.parent.lookupVar(name);
        return undefined;
    }

    deleteVar(name) {
        // TODO involve parent scopes
        if (this.dontDelete.has(name)) return false;
        return this.vars.delete(name);
    }

    setDoNotDelete(name) { this.dontDelete.add(name) }
}

class EnvScope extends Scope {
    constructor(env) {
        super();
        assert(env instanceof VMObject, "environment must be an object");
        this.env = env;
        this.dontDelete = new Set();
    }

    defineVar(kind, name, value) {
        assert(
            kind === 'var' || kind === 'let' || kind === 'const',
            "`kind` must be one of 'var', 'let', or 'const'"
        );
        this.env.setProperty(name, value);
    }
    setVar(name, value) {
        // afaiu, this assert can only fail with a bug
        assert(this.env.hasOwnProperty(name), 'assignment to undeclared global variable: ' + name);
        this.env.setProperty(name, value);
    }

    lookupVar(name) {
        if (!this.env.hasOwnProperty(name)) { return undefined; }
        return this.env.getProperty(name);
    }

    deleteVar(name) {
        if (this.dontDelete.has(name)) return false;
        return this.env.deleteProperty(name);
    }

    setDoNotDelete(name) { this.dontDelete.add(name) }
}


export class VM {
    constructor() {
        this.globalObj = createGlobalObject()
        this.currentScope = null
        this.synCtx = []
        this.synCtxError = []
    }

    //
    // VM state (variables, stack, heap, ...)
    //

    defineVar(kind, name, value) { return this.currentScope.defineVar(kind, name, value); }
    setVar(name, value) { return this.currentScope.setVar(name, value); }
    deleteVar(name) { return this.currentScope.deleteVar(name); }
    lookupVar(name, value) { return this.currentScope.lookupVar(name, value); }
    setDoNotDelete(name) { return this.currentScope.setDoNotDelete(name); }
    withScope(inner) {
        const scope = new VarScope()
        scope.parent = this.currentScope;
        this.currentScope = scope;

        try { return inner(); }
        finally {
            assert(this.currentScope === scope, 'stack manipulated!');
            this.currentScope = scope.parent;
        }
    }

    #unsupportedNode(node) {
        throw new VMError('unsupported node: ' + Deno.inspect(node));
    }

    #withSyntaxContext(node, inner) {
        this.synCtxError = [];
        try {
            this.synCtx.push(node);
            return inner();
        } catch (err) {
            this.synCtxError.push(`${node.type} ${node.loc.start.line}-${node.loc.end.line}`)
            if (node.end - node.start <= 100) {
                const excerpt = node.sourceFile.getRange(node.start, node.end);
                for (const line of excerpt.split('\n')) {
                    this.synCtxError.push('  > ' + line)
                }
            }

            throw err;
        } finally {
            const check = this.synCtx.pop();
            assert(check === node, 'bug! syntax context manipulated');
        }
    }

    //
    // Statements
    //

    runScript(script) {
        const { path, text } = script;
        const ast = acorn.parse(text, {
            ecmaVersion: 'latest',
            directSourceFile: new SourceWrapper(text),
            locations: true,
        });

        return this.runProgram(ast);
    }

    runProgram(node) {
        assert(node.sourceType === "script", 'only script is supported');
        assert(node.type === "Program", 'must be called with a Program node');

        return this.#withSyntaxContext(node, () => {
            try {
                assert(this.currentScope === null, 'nested program!');

                const topScope = new EnvScope(this.globalObj);
                this.currentScope = topScope;
                this.currentScope.this = this.globalObj;

                if (node.body.length > 0 && node.body[0].directive === 'use strict') {
                    this.currentScope.isSetStrict = true;
                }

                this.runBlockBody(node.body);

                assert(this.currentScope === topScope, "stack manipulated!");
                this.currentScope = null;
                return { outcome: 'success' }

            } catch (error) {
                if (error instanceof ProgramException) {
                    const excval = error.exceptionValue;
                    const message = excval.type === 'object' ? excval.getProperty('message') : excval;
                    return {
                        outcome: 'error',
                        message,
                        error,
                    }
                }

                if (this.synCtxError) {
                    console.error('with syntax context:');
                    for (const line of this.synCtxError) {
                        console.error('|  ' + line);
                    }
                    this.synCtxError = [];
                }

                throw error;
            }
        });
    }

    directEval(text) {
        let ast;
        try {
            ast = acorn.parse(text, {
                ecmaVersion: 'latest',
                directSourceFile: new SourceWrapper(text),
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
        assert(ast.type === 'Program', "result of parser is expected to be a Program");
        ast.type = 'BlockStatement';
        return this.runStmt(ast);
    }

    runBlockBody(body) {
        let completion;

        for (const stmt of body) {
            // last iteration's CV becomes block's CV
            completion = this.runStmt(stmt);
        }

        return completion;
    }

    runStmt(stmt) {
        const completionValue = this.#dispatch(stmt, this.stmts)
        if (typeof completionValue === 'undefined')
            return { type: 'undefined' }; // default completion value
        return completionValue;
    }

    performCall(callee, subject, args) {
        assert(callee instanceof VMInvokable, 'you can only call a function (native or virtual), not ' + Deno.inspect(callee));
        assert(subject.type, 'subject should be a VM value');

        return callee.invoke(this, subject, args);
    }

    #dispatch(node, table) {
        return this.#withSyntaxContext(node, () => {
            const handler = table[node.type]
            if (handler) return handler.call(this, node);
            return this.#unsupportedNode(node);
        });
    }

    stmts = {
        // each of these handlers returns the *completion value* of the statement (if any)

        EmptyStatement(stmt) { },

        /** @this VM */
        BlockStatement(stmt) {
            return this.withScope(() => {
                return this.runBlockBody(stmt.body);
            });
        },

        /** @this VM */
        TryStatement(stmt) {
            try {
                return this.withScope(() => this.runStmt(stmt.block));
            } catch (err) {
                if (err instanceof ProgramException && stmt.handler) {
                    assert(stmt.handler.type === 'CatchClause', "parser bug: try statement's handler must be CatchClause");
                    assert(stmt.handler.param.type === 'Identifier', 'only supported: catch clause param Identifier');

                    const paramName = stmt.handler.param.name;
                    const body = stmt.handler.body;
                    this.withScope(() => {
                        this.defineVar('var', paramName, err.exceptionValue);
                        this.setDoNotDelete(paramName);
                        this.runStmt(body);
                    });

                } else {
                    // either pass the ProgramException to another of the program's try blocks
                    // or pass the VMError to the VM caller
                    throw err;
                }
            } finally {
                if (stmt.finalizer)
                    this.withScope(() => this.runStmt(stmt.finalizer));
            }
        },
        ThrowStatement(stmt) {
            const exceptionValue = this.evalExpr(stmt.argument);
            throw new ProgramException(exceptionValue, [...this.synCtx]);
        },

        FunctionDeclaration(stmt) {
            if (stmt.id.type === 'Identifier') {
                const name = stmt.id.name;
                assert(!stmt.expression, "unsupported func decl type: expression");
                assert(!stmt.generator, "unsupported func decl type: generator");
                assert(!stmt.async, "unsupported func decl type: async");

                const func = this.makeFunction(stmt.params, stmt.body);
                assert(typeof name === 'string');
                func.setProperty('name', { type: 'string', value: name });
                this.defineVar('var', name, func);

                return func;

            } else {
                throw new VMError('unsupported identifier for function declaration: ' + Deno.inspect(stmt.id));
            }
        },

        ExpressionStatement(stmt) {
            // expression value becomes completion value
            return this.evalExpr(stmt.expression);
        },

        IfStatement(stmt) {
            const test = this.evalExpr(stmt.test);

            if (this.isTruthy(test)) {
                return this.runStmt(stmt.consequent);
            } else if (stmt.alternate) {
                return this.runStmt(stmt.alternate);
            }
        },

        VariableDeclaration(node) {
            if (node.kind !== "var" && node.kind !== "let" && node.kind !== "const")
                throw new VMError('unsupported var decl type: ' + node.kind);

            let completion;

            for (const decl of node.declarations) {
                assert(decl.type === 'VariableDeclarator', "decl type must be VariableDeclarator");
                if (decl.id.type === "Identifier") {
                    const name = decl.id.name;
                    const value = decl.init ? this.evalExpr(decl.init) : { type: 'undefined' };
                    this.defineVar(node.kind, name, value);

                    if (node.declarations.length === 1)
                        completion = value;

                } else {
                    throw new VMError("unsupported declarator id type: " + decl.id.type)
                }
            }

            return completion;
        },

        ReturnStatement(node) {
            if (node.argument === null)
                throw { returnValue: { type: 'undefined' } };

            const returnValue = this.evalExpr(node.argument);
            throw { returnValue };
        },

        /** @this VM */
        ForStatement(node) {
            this.withScope(() => {
                let completion;

                for (node.init.type === 'VariableDeclaration'
                    ? this.runStmt(node.init)
                    : this.evalExpr(node.init);
                    this.isTruthy(this.evalExpr(node.test));
                    this.evalExpr(node.update)
                ) {
                    // keep overwriting, return the last iteration's completion value
                    completion = this.runStmt(node.body);
                }

                return completion;
            });
        },

        ForInStatement(node) {
            const iteree = this.evalExpr(node.right);
            this.withScope(() => {
                this.runStmt(node.left);

                assert(node.left.type === 'VariableDeclaration');
                assert(node.left.declarations.length === 1);
                assert(node.left.declarations[0].type === 'VariableDeclarator');
                assert(node.left.declarations[0].init === null);
                assert(node.left.declarations[0].id.type === "Identifier");
                const asmtTarget = node.left.declarations[0].id;

                const properties = iteree.getOwnPropertyNames();
                for (const name of properties) {
                    assert(typeof name === 'string');
                    const value = iteree.getOwnProperty(name);
                    this.doAssignment(asmtTarget, value);
                    this.runStmt(node.body);
                }
            });
        }
    }

    //
    // Expressions
    //
    evalExpr(node) {
        const value = this.#dispatch(node, this.exprs);
        assert(
            typeof value === 'object' && typeof value.type === 'string',
            `expr handler for ${node.type} did not return a value: ${Deno.inspect(value)}`
        );
        return value;
    }

    makeFunction(paramNodes, body, options = {}) {
        const params = paramNodes.map(paramNode => {
            assert(paramNode.type === 'Identifier', 'unsupported: func params of type ' + paramNode.type);
            return paramNode.name;
        });

        assert(body.type === 'BlockStatement', "only supported: BlockStatement as function body");
        const func = new VMFunction(params, body);
        func.parentScope = this.currentScope;
        if (!options.scopeStrictnessIrrelevant && this.currentScope.isStrict())
            func.setStrict();

        if (!func.isStrict && body.type === "BlockStatement") {
            const stmts = body.body;
            if (
                stmts.length > 0
                && stmts[0].type === "ExpressionStatement"
                && stmts[0].directive === "use strict"
            ) {
                func.setStrict();
            }
        }

        return func;
    }

    isTruthy({ type, value }) {
        if (type === 'object') {
            throw new VMError('not yet implemented: isTruthy for object');
        }

        assert(typeof value === type, `bug: ${type} value does not have ${type} value, but ${typeof value}!`);

        if (type === 'boolean') { return value; }
        else if (type === 'string') { return value.length > 0; }
        else if (type === 'undefined') { return false; }

        throw new VMError('not yet implemented: isTruthy: ' + Deno.inspect(value));
    }

    performNew(constructor, args) {
        const initObj = new VMObject();
        let obj = this.performCall(constructor, initObj, args);
        if (obj.type === 'undefined') obj = initObj;

        assert(obj instanceof VMObject, 'vm bug: invalid return type from constructor: ' + Deno.inspect(obj));
        obj.setProperty('constructor', constructor);
        obj.proto = constructor.getProperty('prototype');
        return obj;
    }

    doAssignment(targetExpr, value) {
        if (targetExpr.type === "MemberExpression") {
            assert(!targetExpr.optional, 'unsupported: assignment to MemberExpression with .optional = true');

            const obj = this.evalExpr(targetExpr.object);

            let property;
            if (targetExpr.computed) {
                property = this.evalExpr(targetExpr.property);
            } else {
                assert(targetExpr.property.type === 'Identifier', 'unsupported non-computed member property: ' + targetExpr.property.type);
                const propertyName = targetExpr.property.name;
                property = { type: 'string', value: propertyName };
            }

            if (property.type === 'string') {
                obj.setProperty(property.value, value, this);

            } else if (property.type === 'number') {
                obj.setIndex(property.value, value);

            } else {
                vm.throwTypeError("object property is neither number nor string, but " + property.type);
            }


        } else if (targetExpr.type === "Identifier") {
            const name = targetExpr.name;
            this.setVar(name, value);

        } else {
            throw new VMError('unsupported assignment target: ' + Deno.inspect(targetExpr));
        }

        return value;
    }

    throwTypeError(message) { return this.throwError('TypeError', message); }
    throwError(constructorName, message) {
        const excCons = this.globalObj.getProperty(constructorName);
        const messageValue = { type: 'string', value: message };
        const exc = this.performNew(excCons, [messageValue]);
        throw new ProgramException(exc, this.synCtx);
    }

    coerceToObject(value) {
        if (value instanceof VMObject && value.value !== null) return value;

        const proto = {
            number: PROTO_NUMBER,
            boolean: PROTO_BOOLEAN,
            string: PROTO_STRING,
        }[value.type];
        if (proto) {
            const obj = new VMObject(proto);
            obj.primitive = value.value;
            return obj;
        }

        this.throwTypeError("can't convert value to object: " + Deno.inspect(value));
    }

    coerceToBoolean(value) {
        let ret;

        if (value.type === 'boolean') { ret = value.value; }
        else if (value.type === 'undefined') { ret = false; }
        else if (value.type === 'number') {
            // includes both +0 and -0
            ret = value.value !== 0 && !Number.isNaN(value.value);
        }
        else if (value.type === 'bigint') { ret = value.value !== 0n; }
        else if (value.type === 'string') { ret = value.value !== ''; }
        else if (value.type === 'symbol') { ret = true; }
        else if (value.type === 'object') { ret = !(value instanceof VMObject); }
        else {
            this.throwTypeError("can't convert value to boolean: " + Deno.inspect(value));
        }

        return { type: 'boolean', value: ret };
    }

    exprs = {
        AssignmentExpression(expr) {
            let value = this.evalExpr(expr.right);

            if (expr.operator === '=') { }
            else if (expr.operator === '+=') {
                const updateExpr = { ...expr, type: 'BinaryExpression', operator: '+' };
                value = this.evalExpr(updateExpr);
            } else {
                throw new VMError('unsupported update assignment op. ' + Deno.inspect(expr));
            }

            return this.doAssignment(expr.left, value);
        },

        UpdateExpression(expr) {
            const value = this.evalExpr(expr.argument);
            if (value.type !== 'number') {
                this.throwTypeError(`update operation only support on numbers, not ${value.type}`);
            }

            let newValue;
            if (expr.operator === '++') {
                newValue = { type: 'number', value: value.value + 1 };
            } else if (expr.operator === '--') {
                newValue = { type: 'number', value: value.value - 1 };
            } else {
                throw new VMError('unsupported update operator: ' + expr.operator);
            }

            this.doAssignment(expr.argument, newValue);
            return newValue;
        },

        FunctionExpression(expr) {
            assert(expr.id === null, "unsupported: function expression with non-null id: " + expr.id);
            assert(!expr.expression, "unsupported: FunctionExpression.expression");
            assert(!expr.generator, "unsupported: FunctionExpression.generator");
            assert(!expr.async, "unsupported: FunctionExpression.async");

            return this.makeFunction(expr.params, expr.body);
        },

        ObjectExpression(expr) {
            const obj = new VMObject();

            for (const propertyNode of expr.properties) {
                assert(propertyNode.type === 'Property', "node's type === 'Property'");
                assert(propertyNode.method === false, "node's method === false");
                assert(propertyNode.shorthand === false, "node's shorthand === false");
                assert(propertyNode.computed === false, "node's computed === false");

                assert(propertyNode.key.type === 'Identifier');
                const key = propertyNode.key.name;

                if (propertyNode.kind === 'init') {
                    const value = this.evalExpr(propertyNode.value);
                    obj.setProperty(key, value);

                } else if (propertyNode.kind === 'get' || propertyNode.kind === 'set') {
                    const func = this.evalExpr(propertyNode.value);
                    if (!(func instanceof VMInvokable)) {
                        throw new VMError("VM bug: getter/setter was not evaluated as function?");
                    }
                    obj.defineProperty(key, { [propertyNode.kind]: func });

                } else {
                    throw new VMError("unsupported property kind: " + propertyNode.kind);
                }

            }

            return obj;
        },

        ArrayExpression(expr) {
            const elements = expr.elements.map(elmNode => this.evalExpr(elmNode))

            const arrayCons = this.globalObj.getProperty('Array');
            const array = this.performNew(arrayCons, [])
            const pushMethod = array.getProperty('push');
            for (const elm of elements) {
                this.performCall(pushMethod, array, [elm]);
            }

            return array
        },

        MemberExpression(expr) {
            assert(!expr.optional, "unsupported: MemberExpression.optional");

            let object = this.coerceToObject(this.evalExpr(expr.object));

            let key;
            if (expr.computed) {
                key = this.evalExpr(expr.property);
            } else if (expr.property.type === 'Identifier') {
                key = { type: 'string', value: expr.property.name };
            } else {
                throw new AssertionError('MemberExpression: !computed, but property not an Identifier');
            }

            if (key.type === 'string') {
                return object.getProperty(key.value, this);
            } else if (key.type === 'number') {
                return object.getIndex(key.value);
            } else {
                throw new AssertionError('MemberExpression: unsupported key type: ' + key.type);
            }
        },

        UnaryExpression(expr) {
            if (expr.operator === 'delete') {
                assert(expr.prefix, 'parser bug: delete must be prefix');
                if (expr.argument.type === 'Identifier') {
                    const name = expr.argument.name;
                    const didDelete = this.deleteVar(name);
                    return { type: 'boolean', value: didDelete };
                } else if (expr.argument.type === 'MemberExpression') {
                    const obj = this.evalExpr(expr.argument.object);
                    if (!(obj instanceof VMObject))
                        this.throwTypeError("can't delete from non-object");

                    console.log('---')
                    console.log(expr.argument)
                    let property;
                    if (expr.argument.computed) {
                        const nameValue = this.evalExpr(expr.argument.property);
                        if (nameValue.type !== 'string') {
                            vm.throwTypeError("property type is not string");
                        }
                        property = nameValue.value;
                    } else {
                        property = expr.argument.property.name;
                    }

                    const ret = obj.deleteProperty(property);
                    return { type: 'boolean', value: ret };
                } else {
                    throw new VMError('unsupported delete argument: ' + Deno.inspect(expr));
                }


            } else if (expr.operator === 'typeof') {
                const value = this.evalExpr(expr.argument);
                return { type: 'string', value: value.type };

            } else if (expr.operator === '!') {
                assert(expr.prefix === true, "only supported: expr.prefix === true");
                const value = this.coerceToBoolean(this.evalExpr(expr.argument));
                assert(value.type === 'boolean');
                assert(typeof value.value === 'boolean');
                value.value = !value.value;
                return value;

            } else if (expr.operator === '-') {
                const value = this.evalExpr(expr.argument);

                if (value.type === 'number' || value.type === 'bigint') {
                    value.value = -value.value;
                } else {
                    vm.throwTypeError("unary operator '-' not defined for type " + value.type);
                }
                return value;

            } else {
                throw new VMError('unsupported unary op: ' + expr.operator);
            }
        },

        BinaryExpression(expr) {
            const numericOp = (impl) => {
                const a = this.evalExpr(expr.left);
                const b = this.evalExpr(expr.right);
                if (a.type !== 'number' || b.type !== 'number') {
                    this.throwTypeError(`invalid operands for numeric op: ${a.type} and ${b.type}`);
                }
                const retVal = impl(a.value, b.value);
                assert(typeof retVal === 'number' || typeof retVal === 'boolean');
                return { type: typeof retVal, value: retVal };
            };

            if (expr.operator === '===') { return this.tripleEqual(expr.left, expr.right); }
            else if (expr.operator === '!==') {
                const ret = this.tripleEqual(expr.left, expr.right);
                ret.value = !ret.value;
                return ret;
            }
            else if (expr.operator === '+') {
                const left = this.evalExpr(expr.left);
                const right = this.evalExpr(expr.right);

                const a = this.coerceToPrimitive(left);
                const b = this.coerceToPrimitive(right);

                if (a.type === 'number' && b.type === 'number') {
                    return { type: 'number', value: a.value + b.value };
                } else {
                    const as = this.coerceToString(a);
                    const bs = this.coerceToString(b);
                    assert(as.type === 'string', 'coerceToString bug (a)');
                    assert(bs.type === 'string', 'coerceToString bug (b)');
                    return { type: 'string', value: as.value + bs.value };
                }
            }
            else if (expr.operator === '<') { return numericOp((a, b) => (a < b)); }
            else if (expr.operator === '<=') { return numericOp((a, b) => (a <= b)); }
            else if (expr.operator === '>') { return numericOp((a, b) => (a > b)); }
            else if (expr.operator === '>=') { return numericOp((a, b) => (a >= b)); }
            else if (expr.operator === '-') { return numericOp((a, b) => (a - b)); }
            else if (expr.operator === '*') { return numericOp((a, b) => (a * b)); }
            else if (expr.operator === '/') { return numericOp((a, b) => (a / b)); }
            else if (expr.operator === 'instanceof') {
                const constructor = this.evalExpr(expr.right);
                let obj = this.evalExpr(expr.left);
                for (; obj !== null; obj = obj.proto) {
                    const check = obj.getProperty('constructor');
                    if (!check instanceof VMObject) continue;
                    if (check.is(constructor))
                        return { type: 'boolean', value: true };
                }

                return { type: 'boolean', value: false };

            } else { throw new VMError('unsupported binary op: ' + expr.operator); }
        },

        LogicalExpression(expr) {
            if (expr.operator === '||') {
                const left = this.evalExpr(expr.left);
                if (this.isTruthy(left)) { return left; }
                return this.evalExpr(expr.right);

            } else if (expr.operator === '&&') {
                const left = this.evalExpr(expr.left);
                if (!this.isTruthy(left)) { return left; }
                return this.evalExpr(expr.right);

            } else {
                throw new VMError('unsupported logical op: ' + expr.operator);
            }
        },

        ConditionalExpression(expr) {
            const testValue = this.evalExpr(expr.test);
            const test = this.coerceToBoolean(testValue);
            assert(test.type === 'boolean');
            // don't even eval the non-taken branch
            if (test.value === true) { return this.evalExpr(expr.consequent); }
            else if (test.value === false) { return this.evalExpr(expr.alternate); }
            else throw new VMError('bug in coerceToBoolean; returned non-boolean');
        },

        NewExpression(expr) {
            const constructor = this.evalExpr(expr.callee);
            const args = expr.arguments.map(argNode => this.evalExpr(argNode));
            return this.performNew(constructor, args)
        },

        CallExpression(expr) {
            const args = expr.arguments.map(argNode => this.evalExpr(argNode));
            let callThis;
            let callee;

            if (expr.callee.type === 'MemberExpression'
                && expr.callee.property.type === "Identifier"
            ) {
                assert(!expr.callee.computed, "only supported: member call with !computed");
                assert(!expr.callee.optional, "only supported: member call with !optional");

                const name = expr.callee.property.name;

                callThis = this.evalExpr(expr.callee.object);
                callThis = this.coerceToObject(callThis);
                callee = callThis.getProperty(name);
                if (callee.type === 'undefined') {
                    throw new VMError(`can't find method ${name} in ${Deno.inspect(callThis)}`);
                }

            } else if (expr.callee.type === 'Identifier' && expr.callee.name === 'eval') {
                // don't lookup "eval" as a variable, perform "direct eval"

                if (expr.arguments.length === 0)
                    return { type: "undefined" };

                const arg = this.evalExpr(expr.arguments[0]);
                if (arg.type === 'string') {
                    return this.directEval(arg.value);
                } else {
                    return arg;
                }

            } else {
                callThis = { type: "undefined" };
                callee = this.evalExpr(expr.callee);
                if (callee.type === 'undefined' || callee.type === 'null') {
                    throw new VMError("can't invoke undefined/null");
                }
            }

            return this.performCall(callee, callThis, args);
        },

        ThisExpression(expr) {
            for (let scope = this.currentScope; scope; scope = scope.parent) {
                if (scope.this) {
                    return scope.this;
                }
            }

            const isStrict = this.currentScope.isStrict();
            return isStrict ? { type: 'undefined' } : this.globalObj;
        },

        Identifier(node) {
            if (node.name === 'undefined') return { type: "undefined" };

            const value = this.lookupVar(node.name);
            if (value === undefined)
                this.throwError('ReferenceError', 'unbound variable: ' + node.name);

            return value;
        },

        /** @this VM */
        Literal(node) {
            const value = node.value;
            const type = typeof value;

            if (this.currentScope.isStrict()) {
                if (type === 'number') {
                    if (node.raw.match(/^0\d+/)) {
                        // octal literals forbidden in strict mode
                        this.throwError('SyntaxError', 'octal literals are forbidden in strict mode');
                    }
                }
            }

            if (type === 'number' || type === 'string' || type === 'boolean' || type === 'bigint') {
                assert(typeof value === type);
                return { type, value };

            } else if (type === 'object') {
                if (node.value instanceof RegExp) {
                    console.log('creating regexp: ', node.value)
                    return createRegExpFromNative(node.value);

                } else if (node.value === null) {
                    return { type: 'object', value: null };
                }

            } else {
                throw new VMError(`unsupported literal value: ${typeof node.value} ${Deno.inspect(node.value)}`);
            }
        }
    }

    tripleEqual(left, right) {
        left = this.evalExpr(left);
        right = this.evalExpr(right);

        if (left.type !== right.type)
            return { type: 'boolean', value: false };

        const t = left.type;
        let value;
        if (left.type === 'object' && left.value === null)
            value = (right.type === 'object' && right.value === null);
        else if (left instanceof VMObject)
            value = Object.is(left, right);
        else if (t === 'boolean') value = (left.value === right.value);
        else if (t === 'string') value = (left.value === right.value);
        else if (t === 'number') value = (left.value === right.value);
        else if (t === 'bigint') value = (left.value === right.value);
        else if (t === 'undefined') value = true;
        else { throw new VMError('invalid value type: ' + t); }

        assert(typeof value === 'boolean');
        return { type: 'boolean', value };
    }

    coerceToPrimitive(value, order = 'valueOf first') {
        if (value instanceof VMObject) {
            let methods = {
                'valueOf first': ['valueOf', 'toString'],
                'toString first': ['toString', 'valueOf'],
            }[order];
            if (methods === undefined)
                throw new VMError('invalid value for arg "order": ' + order);

            for (const methodName of methods) {
                const method = value.getProperty(methodName);
                if (method instanceof VMInvokable) {
                    const ret = method.invoke(this, value, []);
                    // primitive: can be used
                    if (ret.type !== 'object' && ret.type !== 'undefined')
                        return ret;
                }
            }

            return { type: 'undefined' };

        } else {
            assert(typeof value.type === 'string', 'invalid value');
            return value;
        }
    }

    coerceToString(value) {
        if (value.type === 'object') {
            if (value.value === null) return { type: 'undefined', value: 'null' };

            // Objects are first converted to a primitive by calling its [Symbol.toPrimitive]() (with "string" as hint), toString(), and valueOf() methods, in that order. The resulting primitive is then converted to a string.
            const prim = this.coerceToPrimitive(value, 'toString first');
            if (prim.type === 'undefined') {
                throw new VMError('VM bug: object could not be converted to string (at least Object.prototype.toString should have been called)')
            }

            assert(prim.type !== 'object');
            return this.coerceToString(prim);
        }

        assert(value.type === typeof value.value, "VM bug: invalid primitive value");
        let str;
        if (value.type === 'string') str = value.value;
        else if (value.type === 'undefined') str = 'undefined';
        else if (value.type === 'boolean') str = value.value ? 'true' : 'false';
        else if (value.type === 'number') str = Number.prototype.toString.call(value.value);
        else if (value.type === 'bigint') str = BigInt.prototype.toString.call(value.value);
        else if (value.type === 'symbol') str = Symbol.prototype.toString.call(value.value);
        else throw new VMError('invalid value type: ' + value.type);

        assert(typeof str === 'string');
        return { type: 'string', value: str };
    }
}


function nativeVMFunc(innerImpl) {
    return new class extends VMInvokable {
        // in innerImpl, `this` is the VMInvokable object
        invoke = innerImpl
    }
}

function createRegExpFromNative(innerRE) {
    assert(innerRE instanceof RegExp);
    const obj = new VMObject(PROTO_REGEXP)
    obj.innerRE = innerRE
    obj.setProperty('source', { type: 'string', value: innerRE.source });

    // lastIndex must be an own property (there is a dedicated test262 case)
    obj.defineProperty('lastIndex', {
        set: nativeVMFunc((vm, subject, args) => {
            assert(
                subject.innerRE instanceof RegExp,
                "RegExp.prototype.lastIndex setter can only be called on RegExp objects"
            );
            const arg = args[0] || { type: 'undefined' };
            if (arg.type !== 'number')
                vm.throwTypeError("property lastIndex must be set to a number");
            assert(typeof arg.value === 'number');
            subject.innerRE.lastIndex = arg.value;
        }),
        writable: true,
        enumerable: false,
        configurable: false,
    });

    return obj
}

function createGlobalObject() {
    const G = new VMObject();

    G.setProperty('Error', nativeVMFunc((vm, subject, args) => {
        subject.setProperty('message', args[0]);
        return subject;
    }));
    G.getOwnProperty('Error')
        .getProperty('prototype')
        .setProperty('name', { type: 'string', value: 'Error' })

    function createSimpleErrorType(name) {
        const Error = G.getOwnProperty('Error');
        const parentProto = Error.getProperty('prototype');
        const constructor = new class extends VMInvokable {
            constructor() { super(parentProto); }
            invoke(vm, subject, args) { return Error.invoke(vm, subject, args); }
        }
        constructor.getOwnProperty('prototype').setProperty('name', { type: 'string', value: name });

        G.setProperty(name, constructor);
    }

    createSimpleErrorType('TypeError')
    createSimpleErrorType('SyntaxError')
    createSimpleErrorType('ReferenceError')
    createSimpleErrorType('RangeError')
    createSimpleErrorType('NameError')

    const consObject = nativeVMFunc((vm, subject, args) => {
        throw new Error('not yet implemented: Object()');
    });
    consObject.setProperty('prototype', PROTO_OBJECT);
    consObject.setProperty('defineProperty', nativeVMFunc((vm, subject, args) => {
        const [obj, name, descriptor] = args;
        if (!(obj instanceof VMObject))
            vm.throwTypeError("Object.defineProperty: first argument must be object");
        if (name.type !== 'string')
            vm.throwTypeError("Object.defineProperty: second argument must be string");
        if (!(descriptor instanceof VMObject))
            vm.throwTypeError("Object.defineProperty: third argument must be object");

        assert(typeof name.value === 'string');
        // descriptorValue is a VM value
        if (descriptor.type !== 'object')
            vm.throwError("TypeError", 'invalid descriptor: not an object');

        let getter, setter;
        if (descriptor.hasProperty('get') || descriptor.hasProperty('set')) {
            getter = descriptor.getProperty('get');
            if (!(getter.type === "undefined" || getter instanceof VMInvokable))
                vm.throwError("TypeError", 'invalid descriptor: `get` is not a function');

            setter = descriptor.getProperty('set');
            if (!(setter.type === "undefined" || setter instanceof VMInvokable))
                vm.throwError("TypeError", 'invalid descriptor: `set` is not a function');
        }

        function parseBool(key) {
            const value = descriptor.getProperty('writable');
            if (value.type === 'undefined') value = { type: 'boolean', value: true };
            if (value.type === 'boolean')
                vm.throwError("TypeError", 'invalid descriptor: `writable` is not a boolean');
            return value.value;
        }

        const writable = parseBool('writable');
        const configurable = parseBool('configurable');

        obj.defineProperty(name.value, {
            get: getter,
            set: setter,
            value: descriptor.getProperty('value'),
            writable,
            configurable,
        });
        return { type: 'undefined' };
    }));
    consObject.setProperty('getOwnPropertyDescriptor', nativeVMFunc((vm, subject, args) => {
        /** @type VMObject */
        const obj = vm.coerceToObject(args[0] || { type: 'undefined' });
        const name = args[1];
        if (name === undefined || name.type === 'undefined')
            return { type: 'undefined' };

        const descriptor = obj.getOwnPropertyDescriptor(name.value);
        if (descriptor === undefined)
            return { type: 'undefined' };

        if (descriptor.value === undefined)
            descriptor.value = { type: 'undefined' };

        const encoded = new VMObject();
        if (descriptor.get !== undefined) encoded.setProperty("get", descriptor.get);
        if (descriptor.set !== undefined) encoded.setProperty("set", descriptor.set);
        encoded.setProperty("value", obj.resolveDescriptor(descriptor));
        encoded.setProperty("writable", { type: 'boolean', value: descriptor.writable });
        encoded.setProperty("enumerable", { type: 'boolean', value: descriptor.enumerable });
        encoded.setProperty("configurable", { type: 'boolean', value: descriptor.configurable });
        return encoded;
    }));
    consObject.setProperty('getOwnPropertyNames', nativeVMFunc((vm, subject, args) => {
        /** @type VMObject */
        const obj = vm.coerceToObject(args[0] || { type: 'undefined' });
        const names = obj.getOwnPropertyNames();
        const ret = new VMArray();
        for (const name of names) {
            assert(typeof name === 'string')
            ret.arrayElements.push({ type: 'string', value: name })
        }
        return ret;
    }));
    G.setProperty('Object', consObject);

    G.setProperty('Boolean', nativeVMFunc((vm, subject, args) => {
        if (subject.type !== 'undefined')
            throw new VMError('not yet implemented: new Boolean(...)')
        return vm.coerceToBoolean(args[0]);
    }));

    G.setProperty('String', nativeVMFunc((vm, subject, args) => {
        if (subject.type === 'undefined') {
            // invoked as function, not via new
            return vm.coerceToString(args[0])
        } else {
            // invoked via new
            throw new VMError('not yet implemented: new String(...)')
        }
    }));
    G.getOwnProperty('String').setProperty('fromCharCode', nativeVMFunc((vm, subject, args) => {
        const arg = args[0];
        if (arg === undefined || arg.type === 'undefined')
            return { type: 'string', value: '' };

        if (arg.type !== 'number')
            vm.throwTypeError("String.fromCharCode requires a numeric code point, not " + arg.type);

        const ret = String.fromCharCode(arg.value)
        assert(typeof ret === 'string');
        return { type: 'string', value: ret };
    }));

    G.setProperty('Array', nativeVMFunc((vm, subject, args) => {
        assert(subject.type === 'object', 'Only supported invoking via new Array()');
        return new VMArray();
    }));
    G.getProperty('Array').setProperty('isArray', nativeVMFunc((vm, subject, args) => {
        const value = subject instanceof VMArray;
        return { type: 'boolean', value };
    }));
    G.getProperty('Array').setProperty('prototype', PROTO_ARRAY)

    G.setProperty('Function', nativeVMFunc((vm, subject, args) => {
        // even when invoked as `new Function(...)`, discard this, return another object

        if (args.length === 0 || args[0].type !== 'string')
            vm.throwTypeError("new Function() must be invoked with function's body as text (string)");

        const text = args[0].value;
        const ast = acorn.parse(text, {
            ecmaVersion: 'latest',
            allowReturnOutsideFunction: true,
            directSourceFile: new SourceWrapper(text),
            locations: true,
        });
        assert(ast.type === 'Program');
        ast.type = 'BlockStatement';
        return vm.makeFunction([], ast, { scopeStrictnessIrrelevant: true });
    }));
    G.getProperty('Function').setProperty('prototype', PROTO_FUNCTION);

    G.setProperty('RegExp', nativeVMFunc((vm, subject, args) => {
        const arg = args[0]
        if (arg.type !== 'string')
            vm.throwTypeError('RegExp constructor argument must be string');
        return createRegExpFromNative(new RegExp(arg.value))
    }))
    G.getProperty('RegExp').setProperty('prototype', PROTO_REGEXP)

    G.setProperty('eval', nativeVMFunc((vm, subject, args) => {
        // this function is only looked up for indirect eval; direct eval has a
        // dedicated path in the parser

        // we're calling directEval but this is indirect eval. the scope where
        // the passed code is evaluated in the global scope, not the one
        // where the call appears
        if (args.length === 0)
            return { type: 'undefined' };

        if (args[0].type !== 'string')
            vm.throwTypeError("eval must be called with a string");

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

    }));

    G.setProperty('nativeHello', nativeVMFunc((vm, subject, args) => {
        console.log('hello world!')
        return { type: 'undefined' }
    }));

    G.setProperty('$print', nativeVMFunc((vm, subject, args) => {
        for (const arg of args) {
            const prim = vm.coerceToPrimitive(arg)
            console.log(prim)
        }
        return { type: 'undefined' }
    }));

    for (const name in G.properties) {
        const value = G.properties[name];
        if (value instanceof VMFunction) {
            value.name = name;
        }
    }

    return G;
}

class SourceWrapper {
    #text;
    constructor(text) { this.#text = text }
    getRange(start, end) { return this.#text.slice(start, end) }
}


// vim:ts=4:sts=0:sw=0:et

