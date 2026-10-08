'use strict';

/**
 * Turning a salary definition into monthly component amounts.
 *
 * Each line has a calc method:
 *   fixed      the amount in `value`
 *   percent    `value` % of another component (percent_of = its code) or of GROSS
 *   formula    an expression (see formula.js) over GROSS, other component codes and extra variables
 *   remainder  GROSS minus every other earning, so the earnings always add up to the gross salary
 */

const { compile, evaluate, variables, FormulaError } = require('./formula');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * lines: [{ component_id, code, name, kind, calc, value, percent_of, formula, ... }]
 * vars: extra variables, e.g. { GROSS: 120000 } and payroll figures.
 * Returns { amounts: { CODE: amount }, lines: [...lines with amount], errors: [] }.
 */
function computeComponents(lines, vars = {}) {
  const byCode = new Map(lines.map((l) => [String(l.code).toUpperCase(), l]));
  const values = new Map();
  const errors = [];
  const visiting = new Set();
  const gross = Number(vars.GROSS) || 0;

  function resolve(code) {
    if (values.has(code)) return values.get(code);
    const line = byCode.get(code);
    if (!line) {
      if (code in vars) return Number(vars[code]) || 0;
      throw new FormulaError(`Unknown name ${code}`);
    }
    if (visiting.has(code)) throw new FormulaError(`${code} depends on itself`);
    visiting.add(code);
    let amount = 0;
    try {
      switch (line.calc) {
        case 'percent': {
          const base = String(line.percent_of || 'GROSS').toUpperCase();
          amount = (Number(line.value) || 0) / 100 * (base === 'GROSS' ? gross : resolve(base));
          break;
        }
        case 'formula':
          amount = evaluate(compile(line.formula || '0'), resolve);
          break;
        case 'remainder': {
          let others = 0;
          for (const [c, l] of byCode) {
            if (c === code || l.kind !== 'earning' || l.calc === 'remainder') continue;
            others += resolve(c);
          }
          if (others > gross + 0.05) errors.push(`The other earnings (${round2(others)}) add up to more than the gross salary (${gross}).`);
          amount = Math.max(0, gross - others);
          break;
        }
        default:
          amount = Number(line.value) || 0;
      }
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      errors.push(`${line.name || code}: ${err.message}`);
      amount = 0;
    } finally {
      visiting.delete(code);
    }
    amount = round2(Number.isFinite(amount) ? amount : 0);
    values.set(code, amount);
    return amount;
  }

  const out = lines.map((l) => {
    const code = String(l.code).toUpperCase();
    let amount = 0;
    try { amount = resolve(code); } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      errors.push(`${l.name || code}: ${err.message}`);
    }
    return { ...l, amount };
  });
  return { amounts: Object.fromEntries(values), lines: out, errors: [...new Set(errors)] };
}

/** Check a formula against the known codes; returns an error message or null. */
function checkFormula(src, knownCodes) {
  try {
    const tree = compile(src);
    const unknown = [...variables(tree)].filter((v) => !knownCodes.includes(v));
    if (unknown.length) return `Unknown name${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
    return null;
  } catch (err) {
    return err.message;
  }
}

module.exports = { computeComponents, checkFormula, round2 };
