/** @import { Visitors } from 'zimmerframe' */
/** @import * as Compiler from '#compiler' */
import { walk } from 'zimmerframe';
import { get_parent_rules, get_possible_values, is_outer_global } from './utils.js';
import { regex_ends_with_whitespace, regex_starts_with_whitespace } from '../../patterns.js';
import { get_attribute_chunks, is_text_attribute } from '../../../utils/ast.js';

/**
 * @typedef {{
 *   element: Compiler.AST.RegularElement | Compiler.AST.SvelteElement;
 *   from_render_tag: boolean;
 * }} State
 */
/** @typedef {NODE_PROBABLY_EXISTS | NODE_DEFINITELY_EXISTS} NodeExistsValue */

const NODE_PROBABLY_EXISTS = 0;
const NODE_DEFINITELY_EXISTS = 1;

const whitelist_attribute_selector = new Map([
	['details', ['open']],
	['dialog', ['open']]
]);

/** @type {Compiler.Css.Combinator} */
const descendant_combinator = {
	type: 'Combinator',
	name: ' ',
	start: -1,
	end: -1
};

/** @type {Compiler.Css.RelativeSelector} */
const nesting_selector = {
	type: 'RelativeSelector',
	start: -1,
	end: -1,
	combinator: null,
	selectors: [
		{
			type: 'NestingSelector',
			name: '&',
			start: -1,
			end: -1
		}
	],
	metadata: {
		is_global: false,
		is_global_like: false,
		scoped: false
	}
};

/**
 *
 * @param {Compiler.Css.StyleSheet} stylesheet
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement | Compiler.AST.RenderTag} element
 */
export function prune(stylesheet, element) {
	if (element.type === 'RenderTag') {
		const parent = get_element_parent(element);
		if (!parent) return;

		walk(stylesheet, { element: parent, from_render_tag: true }, visitors);
	} else {
		walk(stylesheet, { element, from_render_tag: false }, visitors);
	}
}

/** @type {Visitors<Compiler.Css.Node, State>} */
const visitors = {
	Rule(node, context) {
		if (node.metadata.is_global_block) {
			context.visit(node.prelude);
		} else {
			context.next();
		}
	},
	ComplexSelector(node, context) {
		const selectors = get_relative_selectors(node);
		const inner = selectors[selectors.length - 1];

		if (context.state.from_render_tag) {
			// We're searching for a match that crosses a render tag boundary. That means we have to both traverse up
			// the element tree (to see if we find an entry point) but also remove selectors from the end (assuming
			// they are part of the render tag we don't see). We do all possible combinations of both until we find a match.
			/** @type {Compiler.AST.RegularElement | Compiler.AST.SvelteElement | null} */
			let element = context.state.element;

			while (element) {
				const selectors_to_check = selectors.slice();

				while (selectors_to_check.length > 0) {
					selectors_to_check.pop();

					if (
						apply_selector(
							selectors_to_check,
							/** @type {Compiler.Css.Rule} */ (node.metadata.rule),
							element,
							context.state
						)
					) {
						mark(inner, element);
						node.metadata.used = true;
						return;
					}
				}

				element = get_element_parent(element);
			}
		} else if (
			apply_selector(
				selectors,
				/** @type {Compiler.Css.Rule} */ (node.metadata.rule),
				context.state.element,
				context.state
			)
		) {
			mark(inner, context.state.element);
			node.metadata.used = true;
		}

		// note: we don't call context.next() here, we only recurse into
		// selectors that don't belong to rules (i.e. inside `:is(...)` etc)
		// when we encounter them below
	}
};

/**
 * Retrieves the relative selectors (minus the trailing globals) from a complex selector.
 * Also searches them for any existing `&` selectors and adds one if none are found.
 * This ensures we traverse up to the parent rule when the inner selectors match and we're
 * trying to see if the parent rule also matches.
 * @param {Compiler.Css.ComplexSelector} node
 */
function get_relative_selectors(node) {
	const selectors = truncate(node);

	if (node.metadata.rule?.metadata.parent_rule && selectors.length > 0) {
		let has_explicit_nesting_selector = false;

		// nesting could be inside pseudo classes like :is, :has or :where
		for (let selector of selectors) {
			walk(
				selector,
				{},
				{
					// @ts-ignore
					NestingSelector() {
						has_explicit_nesting_selector = true;
					}
				}
			);
			// if we found one we can break from the others
			if (has_explicit_nesting_selector) break;
		}

		if (!has_explicit_nesting_selector) {
			if (selectors[0].combinator === null) {
				selectors[0] = {
					...selectors[0],
					combinator: descendant_combinator
				};
			}

			selectors.unshift(nesting_selector);
		}
	}

	return selectors;
}

/**
 * Discard trailing `:global(...)` selectors, these are unused for scoping purposes
 * @param {Compiler.Css.ComplexSelector} node
 */
function truncate(node) {
	const i = node.children.findLastIndex(({ metadata, selectors }) => {
		const first = selectors[0];
		return (
			// not after a :global selector
			!metadata.is_global_like &&
			!(first.type === 'PseudoClassSelector' && first.name === 'global' && first.args === null) &&
			// not a :global(...) without a :has/is/where(...) modifier that is scoped
			!metadata.is_global
		);
	});

	return node.children.slice(0, i + 1).map((child) => {
		// In case of `:root.y:has(...)`, `y` is unscoped, but everything in `:has(...)` should be scoped (if not global).
		// To properly accomplish that, we gotta filter out all selector types except `:has`.
		const root = child.selectors.find((s) => s.type === 'PseudoClassSelector' && s.name === 'root');
		if (!root || child.metadata.is_global_like) return child;

		return {
			...child,
			selectors: child.selectors.filter((s) => s.type === 'PseudoClassSelector' && s.name === 'has')
		};
	});
}

/**
 * @param {Compiler.Css.RelativeSelector[]} relative_selectors
 * @param {Compiler.Css.Rule} rule
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} element
 * @param {State} state
 * @returns {boolean}
 */
function apply_selector(relative_selectors, rule, element, state) {
	const parent_selectors = relative_selectors.slice();
	const relative_selector = parent_selectors.pop();

	if (!relative_selector) return false;

	const possible_match = relative_selector_might_apply_to_node(
		relative_selector,
		rule,
		element,
		state
	);

	if (!possible_match) {
		return false;
	}

	if (relative_selector.combinator) {
		return apply_combinator(
			relative_selector.combinator,
			relative_selector,
			parent_selectors,
			rule,
			element,
			state
		);
	}

	// if this is the left-most non-global selector, mark it — we want
	// `x y z {...}` to become `x.blah y z.blah {...}`
	const parent = parent_selectors[parent_selectors.length - 1];
	if (!parent || is_global(parent, rule)) {
		mark(relative_selector, element);
	}

	return true;
}

/**
 * @param {Compiler.Css.Combinator} combinator
 * @param {Compiler.Css.RelativeSelector} relative_selector
 * @param {Compiler.Css.RelativeSelector[]} parent_selectors
 * @param {Compiler.Css.Rule} rule
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} element
 * @param {State} state
 * @returns {boolean}
 */
function apply_combinator(combinator, relative_selector, parent_selectors, rule, element, state) {
	const name = combinator.name;

	switch (name) {
		case ' ':
		case '>': {
			let parent_matched = false;
			let crossed_component_boundary = false;

			const path = element.metadata.path;
			let i = path.length;

			while (i--) {
				const parent = path[i];

				if (parent.type === 'Component' || parent.type === 'SvelteComponent') {
					crossed_component_boundary = true;
				}

				if (parent.type === 'SnippetBlock') {
					// We assume the snippet might be rendered in a place where the parent selectors match.
					// (We could do more static analysis and check the render tag reference to see if this snippet block continues
					// with elements that actually match the selector, but that would be a lot of work for little gain)
					return true;
				}

				if (parent.type === 'RegularElement' || parent.type === 'SvelteElement') {
					if (apply_selector(parent_selectors, rule, parent, state)) {
						// TODO the `name === ' '` causes false positives, but removing it causes false negatives...
						if (name === ' ' || crossed_component_boundary) {
							mark(parent_selectors[parent_selectors.length - 1], parent);
						}

						parent_matched = true;
					}

					if (name === '>') return parent_matched;
				}
			}

			return parent_matched || parent_selectors.every((selector) => is_global(selector, rule));
		}

		case '+':
		case '~': {
			const siblings = get_possible_element_siblings(element, name === '+');

			let sibling_matched = false;

			for (const possible_sibling of siblings.keys()) {
				if (possible_sibling.type === 'RenderTag' || possible_sibling.type === 'SlotElement') {
					// `{@render foo()}<p>foo</p>` with `:global(.x) + p` is a match
					if (parent_selectors.length === 1 && parent_selectors[0].metadata.is_global) {
						mark(relative_selector, element);
						sibling_matched = true;
					}
				} else if (apply_selector(parent_selectors, rule, possible_sibling, state)) {
					mark(relative_selector, element);
					sibling_matched = true;
				}
			}

			return (
				sibling_matched ||
				(get_element_parent(element) === null &&
					parent_selectors.every((selector) => is_global(selector, rule)))
			);
		}

		default:
			// TODO other combinators
			return true;
	}
}

/**
 * Mark both the compound selector and the node it selects as encapsulated,
 * for transformation in a later step
 * @param {Compiler.Css.RelativeSelector} relative_selector
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} element
 */
function mark(relative_selector, element) {
	if (!is_outer_global(relative_selector)) {
		relative_selector.metadata.scoped = true;
	}
	element.metadata.scoped = true;
}

/**
 * Returns `true` if the relative selector is global, meaning
 * it's a `:global(...)` or unscopeable selector, or
 * is an `:is(...)` or `:where(...)` selector that contains
 * a global selector
 * @param {Compiler.Css.RelativeSelector} selector
 * @param {Compiler.Css.Rule} rule
 */
function is_global(selector, rule) {
	if (selector.metadata.is_global || selector.metadata.is_global_like) {
		return true;
	}

	for (const s of selector.selectors) {
		/** @type {Compiler.Css.SelectorList | null} */
		let selector_list = null;
		let owner = rule;

		if (s.type === 'PseudoClassSelector') {
			if ((s.name === 'is' || s.name === 'where') && s.args) {
				selector_list = s.args;
			}
		}

		if (s.type === 'NestingSelector') {
			owner = /** @type {Compiler.Css.Rule} */ (rule.metadata.parent_rule);
			selector_list = owner.prelude;
		}

		const has_global_selectors = selector_list?.children.some((complex_selector) => {
			return complex_selector.children.every((relative_selector) =>
				is_global(relative_selector, owner)
			);
		});

		if (!has_global_selectors) {
			return false;
		}
	}

	return true;
}

const regex_backslash_and_following_character = /\\(.)/g;

/**
 * Ensure that `element` satisfies each simple selector in `relative_selector`
 *
 * @param {Compiler.Css.RelativeSelector} relative_selector
 * @param {Compiler.Css.Rule} rule
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} element
 * @param {State} state
 * @returns {boolean  }
 */
function relative_selector_might_apply_to_node(relative_selector, rule, element, state) {
	// Sort :has(...) selectors in one bucket and everything else into another
	const has_selectors = [];
	const other_selectors = [];

	for (const selector of relative_selector.selectors) {
		if (selector.type === 'PseudoClassSelector' && selector.name === 'has' && selector.args) {
			has_selectors.push(selector);
		} else {
			other_selectors.push(selector);
		}
	}

	// If we're called recursively from a :has(...) selector, we're on the way of checking if the other selectors match.
	// In that case ignore this check (because we just came from this) to avoid an infinite loop.
	if (has_selectors.length > 0) {
		/** @type {Array<Compiler.AST.RegularElement | Compiler.AST.SvelteElement>} */
		const child_elements = [];
		/** @type {Array<Compiler.AST.RegularElement | Compiler.AST.SvelteElement>} */
		const descendant_elements = [];
		/** @type {Array<Compiler.AST.RegularElement | Compiler.AST.SvelteElement>} */
		let sibling_elements; // do them lazy because it's rarely used and expensive to calculate

		// If this is a :has inside a global selector, we gotta include the element itself, too,
		// because the global selector might be for an element that's outside the component (e.g. :root).
		const rules = [rule, ...get_parent_rules(rule)];
		const include_self =
			rules.some((r) => r.prelude.children.some((c) => c.children.some((s) => is_global(s, r)))) ||
			rules[rules.length - 1].prelude.children.some((c) =>
				c.children.some((r) =>
					r.selectors.some((s) => s.type === 'PseudoClassSelector' && s.name === 'root')
				)
			);
		if (include_self) {
			child_elements.push(element);
			descendant_elements.push(element);
		}

		walk(
			/** @type {Compiler.SvelteNode} */ (element.fragment),
			{ is_child: true },
			{
				_(node, context) {
					if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
						descendant_elements.push(node);

						if (context.state.is_child) {
							child_elements.push(node);
							context.state.is_child = false;
							context.next();
							context.state.is_child = true;
						} else {
							context.next();
						}
					} else {
						context.next();
					}
				}
			}
		);

		// :has(...) is special in that it means "look downwards in the CSS tree". Since our matching algorithm goes
		// upwards and back-to-front, we need to first check the selectors inside :has(...), then check the rest of the
		// selector in a way that is similar to ancestor matching. In a sense, we're treating `.x:has(.y)` as `.x .y`.
		for (const has_selector of has_selectors) {
			const complex_selectors = /** @type {Compiler.Css.SelectorList} */ (has_selector.args)
				.children;
			let matched = false;

			for (const complex_selector of complex_selectors) {
				const selectors = truncate(complex_selector);
				const left_most_combinator = selectors[0]?.combinator ?? descendant_combinator;
				// In .x:has(> y), we want to search for y, ignoring the left-most combinator
				// (else it would try to walk further up and fail because there are no selectors left)
				if (selectors.length > 0) {
					selectors[0] = {
						...selectors[0],
						combinator: null
					};
				}

				const descendants =
					left_most_combinator.name === '+' || left_most_combinator.name === '~'
						? (sibling_elements ??= get_following_sibling_elements(element, include_self))
						: left_most_combinator.name === '>'
							? child_elements
							: descendant_elements;

				let selector_matched = false;

				// Iterate over all descendant elements and check if the selector inside :has matches
				for (const element of descendants) {
					if (
						selectors.length === 0 /* is :global(...) */ ||
						(element.metadata.scoped && selector_matched) ||
						apply_selector(selectors, rule, element, state)
					) {
						complex_selector.metadata.used = true;
						selector_matched = matched = true;
					}
				}
			}

			if (!matched) {
				return false;
			}
		}
	}

	for (const selector of other_selectors) {
		if (selector.type === 'Percentage' || selector.type === 'Nth') continue;

		const name = selector.name.replace(regex_backslash_and_following_character, '$1');

		switch (selector.type) {
			case 'PseudoClassSelector': {
				if (name === 'host' || name === 'root') return false;

				if (
					name === 'global' &&
					selector.args !== null &&
					relative_selector.selectors.length === 1
				) {
					const args = selector.args;
					const complex_selector = args.children[0];
					return apply_selector(complex_selector.children, rule, element, state);
				}

				// We came across a :global, everything beyond it is global and therefore a potential match
				if (name === 'global' && selector.args === null) return true;

				// :not(...) contents should stay unscoped. Scoping them would achieve the opposite of what we want,
				// because they are then _more_ likely to bleed out of the component. The exception is complex selectors
				// with descendants, in which case we scope them all.
				if (name === 'not' && selector.args) {
					for (const complex_selector of selector.args.children) {
						walk(complex_selector, null, {
							ComplexSelector(node, context) {
								node.metadata.used = true;
								context.next();
							}
						});
						const relative = truncate(complex_selector);

						if (complex_selector.children.length > 1) {
							// foo:not(bar foo) means that bar is an ancestor of foo (side note: ending with foo is the only way the selector make sense).
							// We can't fully check if that actually matches with our current algorithm, so we just assume it does.
							// The result may not match a real element, so the only drawback is the missing prune.
							for (const selector of relative) {
								selector.metadata.scoped = true;
							}

							/** @type {Compiler.AST.RegularElement | Compiler.AST.SvelteElement | null} */
							let el = element;
							while (el) {
								el.metadata.scoped = true;
								el = get_element_parent(el);
							}
						}
					}

					break;
				}

				if ((name === 'is' || name === 'where') && selector.args) {
					let matched = false;

					for (const complex_selector of selector.args.children) {
						const relative = truncate(complex_selector);
						const is_global = relative.length === 0;

						if (is_global) {
							complex_selector.metadata.used = true;
							matched = true;
						} else if (apply_selector(relative, rule, element, state)) {
							complex_selector.metadata.used = true;
							matched = true;
						} else if (complex_selector.children.length > 1 && (name == 'is' || name == 'where')) {
							// foo :is(bar baz) can also mean that bar is an ancestor of foo, and baz a descendant.
							// We can't fully check if that actually matches with our current algorithm, so we just assume it does.
							// The result may not match a real element, so the only drawback is the missing prune.
							complex_selector.metadata.used = true;
							matched = true;
							for (const selector of relative) {
								selector.metadata.scoped = true;
							}
						}
					}

					if (!matched) {
						return false;
					}
				}

				break;
			}

			case 'PseudoElementSelector': {
				break;
			}

			case 'AttributeSelector': {
				const whitelisted = whitelist_attribute_selector.get(element.name.toLowerCase());
				if (
					!whitelisted?.includes(selector.name.toLowerCase()) &&
					!attribute_matches(
						element,
						selector.name,
						selector.value && unquote(selector.value),
						selector.matcher,
						selector.flags?.includes('i') ?? false
					)
				) {
					return false;
				}
				break;
			}

			case 'ClassSelector': {
				if (
					!attribute_matches(element, 'class', name, '~=', false) &&
					!element.attributes.some(
						(attribute) => attribute.type === 'ClassDirective' && attribute.name === name
					)
				) {
					return false;
				}

				break;
			}

			case 'IdSelector': {
				if (!attribute_matches(element, 'id', name, '=', false)) {
					return false;
				}

				break;
			}

			case 'TypeSelector': {
				if (
					element.name.toLowerCase() !== name.toLowerCase() &&
					name !== '*' &&
					element.type !== 'SvelteElement'
				) {
					return false;
				}

				break;
			}

			case 'NestingSelector': {
				let matched = false;

				const parent = /** @type {Compiler.Css.Rule} */ (rule.metadata.parent_rule);

				for (const complex_selector of parent.prelude.children) {
					if (
						apply_selector(get_relative_selectors(complex_selector), parent, element, state) ||
						complex_selector.children.every((s) => is_global(s, parent))
					) {
						complex_selector.metadata.used = true;
						matched = true;
					}
				}

				if (!matched) {
					return false;
				}

				break;
			}
		}
	}

	// possible match
	return true;
}

/**
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} element
 * @param {boolean} include_self
 */
function get_following_sibling_elements(element, include_self) {
	const path = element.metadata.path;
	let i = path.length;

	/** @type {Compiler.SvelteNode} */
	let start = element;
	let nodes = /** @type {Compiler.SvelteNode[]} */ (
		/** @type {Compiler.AST.Fragment} */ (path[0]).nodes
	);

	// find the set of nodes to walk...
	while (i--) {
		const node = path[i];

		if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
			nodes = node.fragment.nodes;
			break;
		}

		if (node.type !== 'Fragment') {
			start = node;
		}
	}

	/** @type {Array<Compiler.AST.RegularElement | Compiler.AST.SvelteElement>} */
	const siblings = [];

	// ...then walk them, starting from the node after the one
	// containing the element in question
	for (const node of nodes.slice(nodes.indexOf(start) + 1)) {
		walk(node, null, {
			RegularElement(node) {
				siblings.push(node);
			},
			SvelteElement(node) {
				siblings.push(node);
			}
		});
	}

	if (include_self) {
		siblings.push(element);
	}

	return siblings;
}

/**
 * @param {any} operator
 * @param {any} expected_value
 * @param {any} case_insensitive
 * @param {any} value
 */
function test_attribute(operator, expected_value, case_insensitive, value) {
	if (case_insensitive) {
		expected_value = expected_value.toLowerCase();
		value = value.toLowerCase();
	}
	switch (operator) {
		case '=':
			return value === expected_value;
		case '~=':
			return value.split(/\s/).includes(expected_value);
		case '|=':
			return `${value}-`.startsWith(`${expected_value}-`);
		case '^=':
			return value.startsWith(expected_value);
		case '$=':
			return value.endsWith(expected_value);
		case '*=':
			return value.includes(expected_value);
		default:
			throw new Error("this shouldn't happen");
	}
}

/**
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} node
 * @param {string} name
 * @param {string | null} expected_value
 * @param {string | null} operator
 * @param {boolean} case_insensitive
 */
function attribute_matches(node, name, expected_value, operator, case_insensitive) {
	for (const attribute of node.attributes) {
		if (attribute.type === 'SpreadAttribute') return true;
		if (attribute.type === 'BindDirective' && attribute.name === name) return true;

		if (attribute.type !== 'Attribute') continue;
		if (attribute.name.toLowerCase() !== name.toLowerCase()) continue;

		if (attribute.value === true) return operator === null;
		if (expected_value === null) return true;

		if (is_text_attribute(attribute)) {
			return test_attribute(operator, expected_value, case_insensitive, attribute.value[0].data);
		}

		const chunks = get_attribute_chunks(attribute.value);
		const possible_values = new Set();

		/** @type {string[]} */
		let prev_values = [];
		for (const chunk of chunks) {
			const current_possible_values = get_possible_values(chunk);

			// impossible to find out all combinations
			if (!current_possible_values) return true;

			if (prev_values.length > 0) {
				/** @type {string[]} */
				const start_with_space = [];

				/** @type {string[]} */
				const remaining = [];

				current_possible_values.forEach((current_possible_value) => {
					if (regex_starts_with_whitespace.test(current_possible_value)) {
						start_with_space.push(current_possible_value);
					} else {
						remaining.push(current_possible_value);
					}
				});
				if (remaining.length > 0) {
					if (start_with_space.length > 0) {
						prev_values.forEach((prev_value) => possible_values.add(prev_value));
					}

					/** @type {string[]} */
					const combined = [];

					prev_values.forEach((prev_value) => {
						remaining.forEach((value) => {
							combined.push(prev_value + value);
						});
					});
					prev_values = combined;
					start_with_space.forEach((value) => {
						if (regex_ends_with_whitespace.test(value)) {
							possible_values.add(value);
						} else {
							prev_values.push(value);
						}
					});
					continue;
				} else {
					prev_values.forEach((prev_value) => possible_values.add(prev_value));
					prev_values = [];
				}
			}
			current_possible_values.forEach((current_possible_value) => {
				if (regex_ends_with_whitespace.test(current_possible_value)) {
					possible_values.add(current_possible_value);
				} else {
					prev_values.push(current_possible_value);
				}
			});
			if (prev_values.length < current_possible_values.size) {
				prev_values.push(' ');
			}
			if (prev_values.length > 20) {
				// might grow exponentially, bail out
				return true;
			}
		}
		prev_values.forEach((prev_value) => possible_values.add(prev_value));

		for (const value of possible_values) {
			if (test_attribute(operator, expected_value, case_insensitive, value)) return true;
		}
	}

	return false;
}

/** @param {string} str */
function unquote(str) {
	if ((str[0] === str[str.length - 1] && str[0] === "'") || str[0] === '"') {
		return str.slice(1, str.length - 1);
	}
	return str;
}

/**
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement | Compiler.AST.RenderTag} node
 * @returns {Compiler.AST.RegularElement | Compiler.AST.SvelteElement | null}
 */
function get_element_parent(node) {
	let path = node.metadata.path;
	let i = path.length;

	while (i--) {
		const parent = path[i];

		if (parent.type === 'RegularElement' || parent.type === 'SvelteElement') {
			return parent;
		}
	}

	return null;
}

/**
 * @param {Compiler.AST.RegularElement | Compiler.AST.SvelteElement} element
 * @param {boolean} adjacent_only
 * @returns {Map<Compiler.AST.RegularElement | Compiler.AST.SvelteElement | Compiler.AST.SlotElement | Compiler.AST.RenderTag, NodeExistsValue>}
 */
function get_possible_element_siblings(element, adjacent_only) {
	/** @type {Map<Compiler.AST.RegularElement | Compiler.AST.SvelteElement | Compiler.AST.SlotElement | Compiler.AST.RenderTag, NodeExistsValue>} */
	const result = new Map();
	const path = element.metadata.path;

	/** @type {Compiler.SvelteNode} */
	let current = element;

	let i = path.length;

	while (i--) {
		const fragment = /** @type {Compiler.AST.Fragment} */ (path[i--]);
		let j = fragment.nodes.indexOf(current);

		while (j--) {
			const node = fragment.nodes[j];

			if (node.type === 'RegularElement') {
				const has_slot_attribute = node.attributes.some(
					(attr) => attr.type === 'Attribute' && attr.name.toLowerCase() === 'slot'
				);

				if (!has_slot_attribute) {
					result.set(node, NODE_DEFINITELY_EXISTS);

					if (adjacent_only) {
						return result;
					}
				}
			} else if (is_block(node)) {
				if (node.type === 'SlotElement') {
					result.set(node, NODE_PROBABLY_EXISTS);
				}

				const possible_last_child = get_possible_last_child(node, adjacent_only);
				add_to_map(possible_last_child, result);
				if (adjacent_only && has_definite_elements(possible_last_child)) {
					return result;
				}
			} else if (node.type === 'RenderTag' || node.type === 'SvelteElement') {
				result.set(node, NODE_PROBABLY_EXISTS);
				// Special case: slots, render tags and svelte:element tags could resolve to no siblings,
				// so we want to continue until we find a definite sibling even with the adjacent-only combinator
			}
		}

		current = path[i];

		if (!current || !is_block(current)) break;

		if (current.type === 'EachBlock' && fragment === current.body) {
			// `{#each ...}<a /><b />{/each}` — `<b>` can be previous sibling of `<a />`
			add_to_map(get_possible_last_child(current, adjacent_only), result);
		}
	}

	return result;
}

/**
 * @param {Compiler.AST.EachBlock | Compiler.AST.IfBlock | Compiler.AST.AwaitBlock | Compiler.AST.KeyBlock | Compiler.AST.SlotElement} node
 * @param {boolean} adjacent_only
 * @returns {Map<Compiler.AST.RegularElement, NodeExistsValue>}
 */
function get_possible_last_child(node, adjacent_only) {
	/** @typedef {Map<Compiler.AST.RegularElement, NodeExistsValue>} NodeMap */

	/** @type {Array<Compiler.AST.Fragment | undefined | null>} */
	let fragments = [];

	switch (node.type) {
		case 'EachBlock':
			fragments.push(node.body, node.fallback);
			break;

		case 'IfBlock':
			fragments.push(node.consequent, node.alternate);
			break;

		case 'AwaitBlock':
			fragments.push(node.pending, node.then, node.catch);
			break;

		case 'KeyBlock':
		case 'SlotElement':
			fragments.push(node.fragment);
			break;
	}

	/** @type {NodeMap} */
	const result = new Map();

	let exhaustive = node.type !== 'SlotElement';

	for (const fragment of fragments) {
		if (fragment == null) {
			exhaustive = false;
			continue;
		}

		const map = loop_child(fragment.nodes, adjacent_only);
		exhaustive &&= has_definite_elements(map);

		add_to_map(map, result);
	}

	if (!exhaustive) {
		for (const key of result.keys()) {
			result.set(key, NODE_PROBABLY_EXISTS);
		}
	}

	return result;
}

/**
 * @param {Map<unknown, NodeExistsValue>} result
 * @returns {boolean}
 */
function has_definite_elements(result) {
	if (result.size === 0) return false;
	for (const exist of result.values()) {
		if (exist === NODE_DEFINITELY_EXISTS) {
			return true;
		}
	}
	return false;
}

/**
 * @template T
 * @param {Map<T, NodeExistsValue>} from
 * @param {Map<T, NodeExistsValue>} to
 * @returns {void}
 */
function add_to_map(from, to) {
	from.forEach((exist, element) => {
		to.set(element, higher_existence(exist, to.get(element)));
	});
}

/**
 * @param {NodeExistsValue | undefined} exist1
 * @param {NodeExistsValue | undefined} exist2
 * @returns {NodeExistsValue}
 */
function higher_existence(exist1, exist2) {
	// @ts-expect-error TODO figure out if this is a bug
	if (exist1 === undefined || exist2 === undefined) return exist1 || exist2;
	return exist1 > exist2 ? exist1 : exist2;
}

/**
 * @param {Compiler.SvelteNode[]} children
 * @param {boolean} adjacent_only
 */
function loop_child(children, adjacent_only) {
	/** @type {Map<Compiler.AST.RegularElement, NodeExistsValue>} */
	const result = new Map();

	let i = children.length;

	while (i--) {
		const child = children[i];

		if (child.type === 'RegularElement') {
			result.set(child, NODE_DEFINITELY_EXISTS);
			if (adjacent_only) {
				break;
			}
		} else if (is_block(child)) {
			const child_result = get_possible_last_child(child, adjacent_only);
			add_to_map(child_result, result);
			if (adjacent_only && has_definite_elements(child_result)) {
				break;
			}
		}
	}

	return result;
}

/**
 * @param {Compiler.SvelteNode} node
 * @returns {node is Compiler.AST.IfBlock | Compiler.AST.EachBlock | Compiler.AST.AwaitBlock | Compiler.AST.KeyBlock | Compiler.AST.SlotElement}
 */
function is_block(node) {
	return (
		node.type === 'IfBlock' ||
		node.type === 'EachBlock' ||
		node.type === 'AwaitBlock' ||
		node.type === 'KeyBlock' ||
		node.type === 'SlotElement'
	);
}
