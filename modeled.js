import * as acorn from 'npm:acorn';

// overview of the plan:
//
//  - impl 1: as a naive ast interpreter, validated against test262
//      - vm state includes stack and heap
//      - stack identifies variable by names
//  - impl 2: bytecode interpreter, with coarse instructions

class AssertionError extends Error {}
function assert(value, msg) {
    if (!value) {
        throw new AssertionError('assertion failed: ' + msg);
    }
} 


class VMError extends Error {}

class ProgramException extends Error {
    constructor(exceptionValue, context) {
        super('interpreted js program exception');
        this.exceptionValue = exceptionValue;

        this.context = context.map(node => {
            const {loc: {start, end}, type} = node
            const text 
                = node.end - node.start <= 100 
                ? node.sourceFile.getRange(node.start, node.end) 
                : '...';
            return `${type} - ${start.line}:${start.column}-${end.line}:${end.column} - ${text}`
        });
    }
}

class VMObject {
    #proto = null
    type = 'object'

    constructor(proto = PROTO_OBJECT) {
        this.properties = new Map()
        this.describedProperties = new Map()
        this._proto = proto
    }

    getOwnProperty(name, vm = undefined) {
        const descriptorValue = this.describedProperties.get(name)
        if (descriptorValue) {
            assert (descriptorValue instanceof VMObject);

            const getter = descriptorValue.getOwnProperty('get');
            assert (vm instanceof VM, "looking up described value but vm not passed");
            return vm.performCall(getter, this, []);
        }

        return this.properties.get(name) || { type: 'undefined' }
    }
    getProperty(name, vm = undefined) {
        assert (typeof name === 'string');
        
        let object = this;
        while (object !== null) {
            let value = object.getOwnProperty(name, vm);
            if (value.type !== 'undefined') {
                return value;
            }
            object = object.proto;
        }

        return {type: 'undefined'};
    }
    setProperty(name, value) {
        return this.properties.set(name, value)
    }
    setDescribedProperty(name, descriptorValue) {
        // descriptorValue is a VM value
        assert (typeof name === 'string');
        assert (descriptorValue instanceof VMObject);
        this.describedProperties.set(name, descriptorValue)
    }
    deleteProperty(name) { return this.properties.delete(name) }

    getIndex(index)        { return this.getOwnProperty(String(index)); }
    setIndex(index, value) { return this.setProperty(String(index), value); }

    get proto() { return this._proto }
    set proto(newProto) {
        assert (newProto === null || newProto instanceof VMObject, "VMObject's prototype must be VMObject or null");
        this._proto = newProto;
    }
}

const PROTO_OBJECT = new VMObject(null)

class VMInvokable extends VMObject {
    type = 'function'

    constructor() {
        super(PROTO_FUNCTION);
        this.setProperty('prototype', new VMObject());
    }

    invoke() { throw new AssertionError('invoke not implemented'); }
}

const PROTO_FUNCTION = new VMObject(PROTO_OBJECT)

class VMFunction extends VMInvokable {
    constructor(params, body) {
        super();
        this.params = params;
        this.body = body;
        this.parentScope = null;
    }

    invoke(vm, subject, args) {
        for (const ndx in this.params) {
            const name = this.params[ndx];
            const value = args[ndx] || { type: 'undefined' };
            vm.defineVar(name, value);
        }

        try { vm.runStmt(this.body) }
        catch (e) {
            if (e.returnValue) {
                assert (typeof e.returnValue.type === 'string', "return value uninitialized!");
                return e.returnValue;
            }
            throw e;
        }

        return {type: "undefined"}
    }
}

const PROTO_NUMBER = new VMObject();
const PROTO_BOOLEAN = new VMObject();

const PROTO_STRING = new VMObject();
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
            const ret = vm.performCall(args[1], {type: 'undefined'}, [args[0]]);
            if (ret.type !== 'string')
                vm.throwTypeError('invalid return value from passed function: ' + ret.type);
            return ret.value;
        });
    } else {
        vm.throwTypeError('String.prototype.replace: invalid type for argument #2: ' + args[1].type)
    }

    return {type: 'string', value: retStr};
}))


class VarScope {
    constructor() {
        this.vars = new Map()
        this.parent = null
    }

    defineVar(name, value) {
        assert(typeof name === 'string', 'var name must be string');
        this.vars.set(name, value);
    }

    setVar(name, value) {
        if (this.vars.has(name)) this.vars.set(name, value);
        else if (this.parent) this.parent.setVar(name, value);
        else {
            const exc = new VMObject();
            exc.setProperty('name', {type: 'string', value: 'NameError'});
            exc.setProperty('message', {type: 'string', value:  'unbound variable: ' + name})
            throw new ProgramException(exc, [...this.synCtx]);
        }
    }

    lookupVar(name) {
        const value = this.vars.get(name);
        if (typeof value !== 'undefined') return value;
        if (this.parent) return this.parent.lookupVar(name);
        throw new VMError('unbound variable: ' + name);
    }

    deleteVar(name) {
        // TODO involve parent scopes
        return this.vars.delete(name);
    }
}

class EnvScope {
    constructor(env) {
        assert (env instanceof VMObject, "environment must be an object");
        this.env = env;
        this.dontDelete = new Set();
    }

    defineVar(name, value) { this.env.setProperty(name, value); }
    setVar(name, value) { this.defineVar(name, value); }

    lookupVar(name) {
        // TODO! only the innermost scope is used
        const value = this.env.getProperty(name);
        if (value) return value;
        throw new VMError('unbound variable: ' + name);
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

    defineVar(name, value) { return this.currentScope.defineVar(name, value); }
    setVar(name, value)    { return this.currentScope.setVar(name, value); }
    deleteVar(name)        { return this.currentScope.deleteVar(name); }
    lookupVar(name, value) { return this.currentScope.lookupVar(name, value); }
    setDoNotDelete(name)   { return this.currentScope.setDoNotDelete(name); }
    #withScope(inner) {
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
        } catch(err) {
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
            assert (check === node, 'bug! syntax context manipulated');
        }
    }

    //
    // Statements
    //

    runScript(script) {
      const {path, text} = script;
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
                assert (this.currentScope === null, 'nested program!');

                const topScope = new EnvScope(this.globalObj);
                this.currentScope = topScope;
                this.currentScope.this = this.globalObj;

                this.runBlockBody(node.body);

                assert (this.currentScope === topScope, "stack manipulated!");
                this.currentScope = null;
                return { outcome: 'success' }

            } catch (err) {
                if (err instanceof ProgramException) {
                    return {
                        outcome: 'error',
                        error: err,
                    }
                }

                if (this.synCtxError) {
                    console.error('with syntax context:');
                    for (const line of this.synCtxError) {
                        console.error('|  ' + line);
                    }
                    this.synCtxError = [];
                }

                throw err;
            }
        });
    }

    runBlockBody(body) {
        for (const stmt of body) {
            this.runStmt(stmt);
        }
    }

    runStmt(stmt) { return this.#dispatch(stmt, this.stmts) }

    performCall(callee, subject, args) {
        assert (callee instanceof VMInvokable, 'you can only call a function (native or virtual), not ' + Deno.inspect(callee));
        assert (subject.type, 'subject should be a VM value');

        return this.#withScope(() => {
            this.currentScope.this = subject;
            return callee.invoke(this, subject, args);
        })
    }

    #dispatch(node, table) {
        return this.#withSyntaxContext(node, () => {
            const handler = table[node.type]
            if (handler) return handler.call(this, node);
            return this.#unsupportedNode(node);
        });
    }

    stmts = {
        EmptyStatement(stmt) { },

        BlockStatement(stmt) {
            this.runBlockBody(stmt.body);
        },

        /** @this VM */
        TryStatement(stmt) {
            try {
                this.#withScope(() => this.runStmt(stmt.block));
            } catch(err) {
                if (err instanceof ProgramException && stmt.handler) {
                    assert(stmt.handler.type === 'CatchClause', "parser bug: try statement's handler must be CatchClause");
                    assert(stmt.handler.param.type === 'Identifier', 'only supported: catch clause param Identifier');
                    
                    const paramName = stmt.handler.param.name;
                    const body = stmt.handler.body;
                    this.#withScope(() => {
                        this.defineVar(paramName, err.exceptionValue);
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
                    this.#withScope(() => this.runStmt(stmt.finalizer));
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
                assert(!stmt.generator,  "unsupported func decl type: generator");
                assert(!stmt.async,      "unsupported func decl type: async");

                this.defineVar(name, this.makeFunction(stmt.params, stmt.body));
                
            } else {
                throw new VMError('unsupported identifier for function declaration: ' + Deno.inspect(stmt.id));
            }
        },

        ExpressionStatement(stmt) {
            // discard return value
            this.evalExpr(stmt.expression);
        },

        IfStatement(stmt) {
            const test = this.evalExpr(stmt.test);

            if (this.isTruthy(test)) {
                this.runStmt(stmt.consequent);
            } else if (stmt.alternate) {
                this.runStmt(stmt.alternate);
            }
        },
        
        VariableDeclaration(node) {
            if (node.kind !== "var" && node.kind !== "let" && node.kind !== "const")
                throw new VMError('unsupported var decl type: ' + node.kind);

            for (const decl of node.declarations) {
                assert (decl.type === 'VariableDeclarator', "decl type must be VariableDeclarator");
                if (decl.id.type === "Identifier") {
                    const name = decl.id.name;
                    const value = decl.init ? this.evalExpr(decl.init) : { type: 'undefined' };
                    this.defineVar(name, value);

                } else {
                    throw new VMError("unsupported declarator id type: " + decl.id.type)
                }
            }
        },

        ReturnStatement(node) {
            if (node.argument === null)
                throw {returnValue: {type: 'undefined'}};

            const returnValue = this.evalExpr(node.argument);
            throw { returnValue };
        },

        /** @this VM */
        ForStatement(node) {
            this.#withScope(() => {
                for(node.init.type === 'VariableDeclaration' 
                        ? this.runStmt(node.init) 
                        : this.evalExpr(node.init);
                    this.isTruthy(this.evalExpr(node.test));
                    this.evalExpr(node.update)
                ) {
                    this.runStmt(node.body);
                }
            });
        },
    }

    //
    // Expressions
    //
    evalExpr(node) { 
        const value = this.#dispatch(node, this.exprs);
        assert (
            typeof value === 'object' && typeof value.type === 'string',
            `expr handler for ${node.type} did not return a value: ${Deno.inspect(value)}`
        );
        return value;
    }

    makeFunction(paramNodes, body) {
        const params = paramNodes.map(paramNode => {
            assert(paramNode.type === 'Identifier', 'unsupported: func params of type ' + paramNode.type);
            return paramNode.name;
        });

        const func = new VMFunction(params, body);
        func.parentScope = this.currentScope;
        return func;
    }

    isTruthy({ type, value }) {
        if (type === 'object') {
            throw new VMError('not yet implemented: isTruthy for object');
        }

        assert (typeof value === type, `bug: ${type} value does not have ${type} value, but ${typeof value}!`);

        if (type === 'boolean') { return value; }
        else if (type === 'string') { return value.length > 0; }

        throw new VMError('not yet implemented: isTruthy: ' + Deno.inspect(value));
    }

    performNew(constructor, args) {
        const obj = new VMObject();
        const retVal = this.performCall(constructor, obj, args);
        assert (typeof retVal === 'object', 'vm bug: invalid return type from call');
        obj.setProperty('constructor', constructor);
        obj.proto = constructor.getProperty('prototype');
        return retVal.type === 'undefined' ? obj : retVal;
    }

    doAssignment(targetExpr, value) {
        if (targetExpr.type === "MemberExpression") {
            const obj = this.evalExpr(targetExpr.object);
            assert(targetExpr.property.type === 'Identifier', 'unsupported member property: ' + targetExpr.property.type);
            const propertyName = targetExpr.property.name;

            obj.setProperty(propertyName, value);

        } else if (targetExpr.type === "Identifier") {
            const name = targetExpr.name;
            this.setVar(name, value);
        
        } else {
            throw new VMError('unsupported assignment target: ' + Deno.inspect(stmt.id));
        }

        return value;
    }

    throwTypeError(message) {
        const excCons = this.globalObj.getProperty('TypeError');
        const messageValue = {type: 'string', value: message};
        const exc = this.performNew(excCons, [messageValue]);
        console.log(exc)
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

        return {type: 'boolean', value: ret};
    }

    exprs = {
        AssignmentExpression(expr) {
            let value = this.evalExpr(expr.right);
            
            if (expr.operator === '=') { }
            else if (expr.operator === '+=') {
                const updateExpr = {...expr, type: 'BinaryExpression', operator: '+'};
                value = this.evalExpr(updateExpr);
            } else {
                throw new VMError('unsupported update assignment op. ' + Deno.inspect(expr));
            }

            assert(!expr.left.computed, 'unsupported: MemberExpression.computed');
            assert(!expr.left.optional, 'unsupported: MemberExpression.optional');
            return this.doAssignment(expr.left, value);
        },

        UpdateExpression(expr) {
            const value = this.evalExpr(expr.argument);
            if (value.type !== 'number') {
                this.throwTypeError(`update operation only support on numbers, not ${value.type}`);
            }

            let newValue;
            if (expr.operator === '++') {
                newValue = {type: 'number', value: value.value + 1};
            } else if (expr.operator === '--') {
                newValue = {type: 'number', value: value.value - 1};
            } else {
                throw new VMError('unsupported update operator: ' + expr.operator);
            }

            this.doAssignment(expr.argument, newValue);
            return newValue;
        },

        FunctionExpression(expr) {
            assert(expr.id === null, "unsupported: function expression with non-null id: " + expr.id);
            assert(!expr.expression, "unsupported: FunctionExpression.expression");
            assert(!expr.generator,  "unsupported: FunctionExpression.generator");
            assert(!expr.async,      "unsupported: FunctionExpression.async");

            return this.makeFunction(expr.params, expr.body);
        },

        ObjectExpression(expr) {
            const obj = new VMObject();

            for (const propertyNode of expr.properties) {
                assert (propertyNode.type === 'Property');                
                assert (propertyNode.method === false);                
                assert (propertyNode.shorthand === false);                
                assert (propertyNode.computed === false);                
                assert (propertyNode.kind === 'init');                

                assert (propertyNode.key.type === 'Identifier');
                const key = propertyNode.key.name;
                const value = this.evalExpr(propertyNode.value);
                obj.setProperty(key, value);
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
                assert (expr.prefix, 'parser bug: delete must be prefix');
                assert (expr.argument.type === 'Identifier', 'only supported: delete <Identifier>');

                const name = expr.argument.name;
                const didDelete = this.deleteVar(name);
                return {type: 'boolean', value: didDelete};

            } else if (expr.operator === 'typeof') {
                const value = this.evalExpr(expr.argument);
                return {type: 'string', value: value.type};

            } else if (expr.operator === '!') {
                assert (expr.prefix === true, "only supported: expr.prefix === true");
                const value = this.coerceToBoolean(this.evalExpr(expr.argument));
                assert (value.type === 'boolean');
                assert (typeof value.value === 'boolean');
                value.value = !value.value;
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
                assert (typeof retVal === 'number' || typeof retVal === 'boolean');
                return {type: typeof retVal, value: retVal};
            };

            if      (expr.operator === '===') { return this.tripleEqual(expr.left, expr.right); }
            else if (expr.operator === '!==') {
                const ret = this.tripleEqual(expr.left, expr.right);
                ret.value = !ret.value;
                return ret;
            }
            else if (expr.operator === '+') {
                const left = this.evalExpr(expr.left);
                const right = this.evalExpr(expr.right);
                
                const a = this.valueToPrimitive(left);
                const b = this.valueToPrimitive(right);

                if (a.type === 'number' && b.type === 'number') {
                    return {type: 'number', value: a.value + b.value};
                } else {
                    const as = this.valueToString(a);
                    const bs = this.valueToString(b);
                    assert (as.type === 'string', 'valueToString bug (a)');
                    assert (bs.type === 'string', 'valueToString bug (b)');
                    return {type: 'string', value: as.value + bs.value};
                }
            }
            else if (expr.operator === '<')  { return numericOp((a, b) => (a < b)); }
            else if (expr.operator === '<=') { return numericOp((a, b) => (a <= b)); }
            else if (expr.operator === '>')  { return numericOp((a, b) => (a > b)); }
            else if (expr.operator === '>=') { return numericOp((a, b) => (a >= b)); }
            else if (expr.operator === '-')  { return numericOp((a, b) => (a - b)); }
            else if (expr.operator === '*')  { return numericOp((a, b) => (a * b)); }
            else if (expr.operator === '/')  { return numericOp((a, b) => (a / b)); }
            else { throw new VMError('unsupported binary op: ' + expr.operator); }
        },

        LogicalExpression(expr) {
            if (expr.operator === '||') {
                const left = this.evalExpr(expr.left);
                if (this.isTruthy(left)) { return left; }
                return this.evalExpr(expr.right);

            } else  if (expr.operator === '&&') {
                const left = this.evalExpr(expr.left);
                if (!this.isTruthy(left)) { return left; }
                return this.evalExpr(expr.right);

            } else {
                throw new VMError('unsupported logical op: ' + expr.operator);
            }
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
                assert (!expr.callee.computed, "only supported: member call with !computed");
                assert (!expr.callee.optional, "only supported: member call with !optional");

                const name = expr.callee.property.name;

                callThis = this.evalExpr(expr.callee.object);
                callThis = this.coerceToObject(callThis);
                callee = callThis.getProperty(name);
                if (callee.type === 'undefined') {
                    throw new VMError(`can't find method ${name} in ${Deno.inspect(callThis)}`);
                }

            } else {
                callThis = { type: "undefined" };
                callee = this.evalExpr(expr.callee);
                if (callee.type === 'undefined' || callee.type === 'null') {
                    throw new VMError(`can't invoke undefined/null: ${Deno.inspect(expr.callee)}`);
                }
            }

            return this.performCall(callee, callThis, args);
        },

        ThisExpression(expr) { 
            for (let scope=this.currentScope; scope; scope = scope.parent) {
                if (scope.this) return scope.this;
            }
            return {type: 'undefined'};
        },

        Identifier(node) {
            return this.lookupVar(node.name);
        },

        Literal(node) {
            const value = node.value;
            const type = typeof value;

            if (type === 'number' || type === 'string' || type === 'boolean') {
                assert (typeof value === type);
                return {type, value};

            } else if(node.value instanceof RegExp) {
                const regexp_cons = this.globalObj.getProperty('RegExp')
                return regexp_cons._fromNativeRegExp(node.value);

            } else {
                throw new VMError(`unsupported literal value: ${typeof node.value} ${Deno.inspect(node.value)}`);
            }
        }
    }

    tripleEqual(left, right) {
        left = this.evalExpr(left);
        right = this.evalExpr(right);

        const value = (left.type === right.type && left.value === right.value);
        return { type: 'boolean', value };
    }

    valueToPrimitive(value) {
        if (value instanceof VMObject) {
            for (const methodName of ['valueOf', 'toString']) {
                const method = value.getOwnProperty(methodName);
                if (method.type !== 'function') continue;

                const ret = this.performCall(method, value, []);
                if (ret.type !== 'object') return ret;
                
            }

            return { type: 'undefined' };
            
        } else {
            assert (typeof value.type === 'string', 'invalid value');
            return value;
        }
    }

    valueToString(value) {
        if (value instanceof VMObject) {
            throw new VMError('bug: value must be primitive')
        }

        assert (value.type === typeof value.value, 'invalid value');

        return {
            type: 'string', 
            value: '' + value.value
        };
    }
}


function nativeVMFunc(innerImpl) {
    return new class extends VMInvokable {
        // in innerImpl, `this` is the VMInvokable object
        invoke = innerImpl
    }
}

function createGlobalObject() {
    const G = new VMObject();

    G.setProperty('Error', nativeVMFunc((vm, subject, args) => {
        subject.setProperty('message', args[0]);
        return subject;
    }));
    G.getOwnProperty('Error')
        .getProperty('prototype')
        .setProperty('name', {type: 'string', value: 'Error'})

    function createSimpleErrorType(name) { 
        const Error = G.getOwnProperty('Error');
        const parentProto = Error.getProperty('prototype');
        const constructor = new class extends VMInvokable {
            constructor() { super(parentProto); }
            invoke(vm, subject, args) { return Error.invoke(vm, subject, args); }
        }
        constructor.getOwnProperty('prototype').setProperty('name', {type: 'string', value: name});

        G.setProperty(name, constructor);
    }

    createSimpleErrorType('TypeError')
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

        obj.setDescribedProperty(name.value, descriptor);
        return {type: 'undefined'};
    }));
    G.setProperty('Object', consObject);

    G.setProperty('String', nativeVMFunc((vm, subject, args) => { 
        if(subject.type === 'undefined') {
            // invoked as function, not via new
            return vm.valueToString(args[0])
        } else {
            // invoked via new
            throw new VMError('not yet implemented: new String(...)')
        }
    }));
    G.getOwnProperty('String').setProperty('fromCharCode', nativeVMFunc((vm, subject, args) => {
        const arg = args[0];
        if (arg.type !== 'number')
            vm.throwTypeError("String.fromCharCode requires a numeric code point, not " + arg.type);

        const ret = String.fromCharCode(arg.value)
        assert (typeof ret === 'string');
        return {type: 'string', value: ret};
    }));

    G.setProperty('Array', nativeVMFunc((vm, subject, args) => { 
        assert(subject.type === 'object', 'Only supported invoking via new Array()');

        subject.arrayElements = [];

        subject.setProperty('push', nativeVMFunc((vm, subject, args) => {
            if (typeof args[0] !== 'undefined')
                subject.arrayElements.push(args[0])
        }));

        return {type: 'undefined'}
    }));

    const regexp_proto = new VMObject();
    regexp_proto.setProperty('test', nativeVMFunc((vm, subject, args) => {
        const arg = args[0]
        if (arg.type !== 'string') {
            vm.throwTypeError('RegExp.test argument must be string')
        }

        const ret = subject.innerRE.test(arg.value)
        assert (typeof ret === 'boolean')
        return {type: 'boolean', value: ret}
    }));

    G.setProperty('RegExp', new class extends VMInvokable {
        constructor() {
            super(regexp_proto);
        }

        _fromNativeRegExp(innerRE) {
            assert (innerRE instanceof RegExp);
            const obj = new VMObject()
            obj.innerRE = innerRE
            obj.proto = regexp_proto
            obj.setProperty('constructor', this)
            obj.setProperty('source', {type: 'string', value: innerRE.source})
            return obj
        }

        invoke(vm, subject, args) {
            const arg = args[0]
            if (arg.value !== 'string') {
                vm.throwTypeError('RegExp constructor argument must be string');
            }

            subject.innerRE = new RegExp(arg.value)
        }
    })

    G.setProperty('nativeHello', nativeVMFunc((vm, subject, args) => { 
        console.log('hello world!')
        return {type: 'undefined'}
    }));

    G.setProperty('$print', nativeVMFunc((vm, subject, args) => {
        for (const arg of args) {
            const prim = vm.valueToPrimitive(arg)
            console.log(prim)
        }
        return {type: 'undefined'}
    }));

    return G;
}

class SourceWrapper {
    #text;
    constructor(text) { this.#text = text }
    getRange(start, end) { return this.#text.slice(start, end) }
}


// vim:ts=4:sts=0:sw=0:et

