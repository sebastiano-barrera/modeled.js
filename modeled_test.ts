import * as M from "./modeled.ts";
import * as acorn from "npm:acorn";
import * as acornWalk from "npm:acorn-walk";

import { expect } from "jsr:@std/expect";

function useNewVM(): Disposable {
	if (M._CV !== undefined) {
		throw new Error("nested VM running!");
	}

	const vm = new M.VM();
	vm.currentScope = new M.VarScope();
	M.setVM(vm);

	return {
		[Symbol.dispose]() {
			vm.currentScope = null;
			M.clearVM();
		},
	};
}

function findPatternJS(patternJS: string): acorn.Pattern {
	const ast: acorn.Program = acorn.parse(patternJS, { ecmaVersion: 2020 });
	const node1 = ast.body[0];
	if (
		node1.type !== 'VariableDeclaration'
		|| node1.declarations.length !== 1
	) throw new Error('invalid test js: not in the form: [var x = _]');
	return node1.declarations[0].id;
}

function bindingPatternJS(patternJS: string, value: M.JSValue): BindingSet {
	const patternAST = findPatternJS(patternJS);
	return bindingPattern(patternAST, value);
}

type BindingSet = { [newIdent: string]: M.JSValue };

function bindingPattern(
	pattern: acorn.Pattern,
	value: M.JSValue,
	bset?: BindingSet,
): BindingSet {
	bset ??= {};

	if (pattern.type === "Identifier") {
		const ident = pattern.name;
		bset[ident] = value;
	} else if (pattern.type === "ObjectPattern") {
		if (value instanceof M.VMObject) {
			const count = pattern.properties.length;
			if (count === 0)
				return bset;

			const last = pattern.properties[count - 1];
			const restObj: undefined | M.VMObject
				= last.type === "RestElement" 
				? value.shallowCopy()
				: undefined;

			for (const prop of pattern.properties) {
				if (prop.type === "Property") {
					if (prop.key.type === "Identifier") {
						const key = prop.key.name;
						const subValue = value.getProperty(key) ?? {type: 'undefined'};
						bindingPattern(prop.value, subValue, bset);
						if (restObj !== undefined) {
							restObj.deleteProperty(key);
						}
					} else {
						M._CV?.throwError("TypeError", "unsupported syntax for object pattern key: " + prop.key.type);
					}
				} else if (prop.type === "RestElement") {
					if (restObj instanceof M.VMObject) {
						bindingPattern(prop.argument, restObj, bset);
					} else {
						throw new Error('there should be an object here!');
					}

				} else {
					const x: never = prop;
				}
			}
		} else {
			M._CV?.throwError(
				"TypeError",
				`type ${value.type} can't be matched to object pattern`,
			);
		}

	} else if (pattern.type === "AssignmentPattern") {
		if (value.type === 'undefined') {
			const fallbackValue = M._CV!.evalExpr(pattern.right);
			bindingPattern(pattern.left, fallbackValue, bset);
		} else {
			bindingPattern(pattern.left, value, bset);
		}

	} else {
		throw new Error("unsupported/invalid pattern type: " + pattern.type);
	}

	return bset;
}

Deno.test("simple identifier", () => {
	using _ = useNewVM();
	const value: M.JSValue = { type: "number", value: 123.0 };
	const bset = bindingPatternJS("var x", value);
	expect(bset).toMatchObject({ x: value });
});

Deno.test("empty object <- object", () => {
	using _ = useNewVM();
	const value = new M.VMObject();
	bindingPatternJS("var {} = _;", value);
});

Deno.test("empty object <- non object", () => {
	expect(() => {
		using _ = useNewVM();
		const value: M.JSValue = { type: "number", value: 123.0 };
		bindingPatternJS("var {} = _", value);
	}).toThrow(M.ProgramException);
});

Deno.test("object: single property", () => {
	using _ = useNewVM();
	const num: M.JSValue = { type: "number", value: 123.0 };
	const value = new M.VMObject();
	value.setProperty("lol", num);
	const bset = bindingPatternJS("var {lol} = _", value);
	expect(bset.lol).toBe(num);
});

Deno.test("object: single property, absent", () => {
	using _ = useNewVM();
	const value = new M.VMObject();
	const bset = bindingPatternJS("var {lol} = _", value);
	expect(bset.lol).toMatchObject({type: 'undefined'});
});

Deno.test("object: single property, default", () => {
	using _ = useNewVM();
	const value = new M.VMObject();
	const bset = bindingPatternJS("var {lol = 99} = _", value);
	expect(bset.lol).toMatchObject({type: 'number', value: 99.0});
});

Deno.test("pattern: object, single property", () => {
	const ast = findPatternJS("var {lol} = _");
	expect(ast.type).toBe("ObjectPattern");
});

Deno.test("pattern: object, mix", () => {
	using _ = useNewVM();

	const num: M.JSValue = { type: "number", value: 123.0 };
	const value = new M.VMObject();
	value.setProperty("lol", num);
	value.setProperty("rofl", {type: "string", value: "something something"});

	const bset = bindingPatternJS("var {asd = 99, lol} = _", value);

	const keys = Object.keys(bset);
	keys.sort();
	expect(keys).toHaveLength(2);
	expect(keys).toContain('asd');
	expect(keys).toContain('lol');
	expect(bset.asd).toMatchObject({type: 'number', value: 99.0});
	expect(bset.lol).toMatchObject({type: 'number', value: 123.0});
});

Deno.test("pattern: object, ...rest", () => {
	using _ = useNewVM();

	const value = new M.VMObject();
	value.setProperty("a", { type: "number", value: 1.0 });
	value.setProperty("b", { type: "number", value: 2.0 });
	value.setProperty("c", { type: "number", value: 3.0 });
	value.setProperty("d", { type: "number", value: 4.0 });
	value.setProperty("e", { type: "number", value: 5.0 });

	const bset = bindingPatternJS("var {a, b, ...more} = _", value);

	const keys = Object.keys(bset);
	keys.sort();
	expect(keys).toHaveLength(3);
	expect(keys).toContain('a');
	expect(keys).toContain('b');
	expect(keys).toContain('more');

	expect(bset.a).toMatchObject({type: 'number', value: 1.0});
	expect(bset.b).toMatchObject({type: 'number', value: 2.0});
});


