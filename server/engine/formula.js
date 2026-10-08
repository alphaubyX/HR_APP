'use strict';

/**
 * A small, safe expression language for salary components, e.g.
 *   GROSS * 0.6667
 *   BASIC * 45 / 100
 *   max(0, min(BASIC * 0.1, 5000))
 *   if(GROSS > 100000, 2500, 1500)
 * Numbers, + - * / %, comparisons (< <= > >= == !=), && || !, parentheses, variables (component
 * codes and GROSS) and the functions min, max, round, floor, ceil, abs, if. Nothing else runs.
 */

const FUNCTIONS = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  round: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  abs: (x) => Math.abs(x),
  if: (c, a, b) => (c ? a : b),
};

class FormulaError extends Error {}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|&&|\|\||[-+*/%(),<>!]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new FormulaError(`Unexpected "${src.slice(pos).trim()[0]}" in formula`);
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'op', v: m[3] });
  }
  return tokens;
}

/** Parse into a tree once; evaluate it many times. */
function parse(src) {
  if (typeof src !== 'string' || !src.trim()) throw new FormulaError('Formula is empty');
  if (src.length > 500) throw new FormulaError('Formula is too long');
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => tokens[i] && tokens[i].t === 'op' && tokens[i].v === v;
  const expect = (v) => { if (!isOp(v)) throw new FormulaError(`Expected "${v}" in formula`); i++; };

  const binary = (next, ops) => () => {
    let left = next();
    while (tokens[i] && tokens[i].t === 'op' && ops.includes(tokens[i].v)) {
      const op = tokens[i++].v;
      left = { k: 'bin', op, a: left, b: next() };
    }
    return left;
  };
  function unary() {
    if (isOp('-') || isOp('+') || isOp('!')) { const op = tokens[i++].v; return { k: 'un', op, a: unary() }; }
    return primary();
  }
  function primary() {
    const tok = peek();
    if (!tok) throw new FormulaError('Formula ends too early');
    if (tok.t === 'num') { i++; return { k: 'num', v: tok.v }; }
    if (tok.t === 'id') {
      i++;
      if (isOp('(')) {
        const name = tok.v.toLowerCase();
        if (!FUNCTIONS[name]) throw new FormulaError(`Unknown function ${tok.v}`);
        i++;
        const args = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) { i++; args.push(or()); }
        }
        expect(')');
        return { k: 'call', name, args };
      }
      return { k: 'var', name: tok.v.toUpperCase() };
    }
    if (isOp('(')) { i++; const e = or(); expect(')'); return e; }
    throw new FormulaError(`Unexpected "${tok.v}" in formula`);
  }
  const mul = binary(unary, ['*', '/', '%']);
  const add = binary(mul, ['+', '-']);
  const cmp = binary(add, ['<', '<=', '>', '>=', '==', '!=']);
  const and = binary(cmp, ['&&']);
  const or = binary(and, ['||']);

  const tree = or();
  if (i < tokens.length) throw new FormulaError(`Unexpected "${tokens[i].v}" in formula`);
  return tree;
}

function variables(tree, out = new Set()) {
  if (tree.k === 'var') out.add(tree.name);
  else if (tree.k === 'bin') { variables(tree.a, out); variables(tree.b, out); }
  else if (tree.k === 'un') variables(tree.a, out);
  else if (tree.k === 'call') tree.args.forEach((a) => variables(a, out));
  return out;
}

/** lookup(name) returns the variable's value (may throw for unknown names). */
function evaluate(tree, lookup) {
  switch (tree.k) {
    case 'num': return tree.v;
    case 'var': return lookup(tree.name);
    case 'un': {
      const a = evaluate(tree.a, lookup);
      return tree.op === '-' ? -a : tree.op === '!' ? Number(!a) : a;
    }
    case 'call': return FUNCTIONS[tree.name](...tree.args.map((a) => evaluate(a, lookup)));
    case 'bin': {
      const a = evaluate(tree.a, lookup);
      const b = evaluate(tree.b, lookup);
      switch (tree.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '%': return b === 0 ? 0 : a % b;
        case '<': return Number(a < b);
        case '<=': return Number(a <= b);
        case '>': return Number(a > b);
        case '>=': return Number(a >= b);
        case '==': return Number(a === b);
        case '!=': return Number(a !== b);
        case '&&': return Number(Boolean(a) && Boolean(b));
        case '||': return Number(Boolean(a) || Boolean(b));
        default: throw new FormulaError(`Unknown operator ${tree.op}`);
      }
    }
    default: throw new FormulaError('Bad formula');
  }
}

const cache = new Map();
function compile(src) {
  let tree = cache.get(src);
  if (!tree) {
    tree = parse(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, tree);
  }
  return tree;
}

module.exports = { parse, compile, evaluate, variables, FormulaError, FUNCTIONS };
