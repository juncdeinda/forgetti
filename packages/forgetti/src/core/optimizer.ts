import type * as babel from '@babel/core';
import * as t from '@babel/types';
import { RUNTIME_EQUALS } from './imports';
import isConstant from './is-constant';
import OptimizerScope from './optimizer-scope';
import type { ComponentNode, OptimizedExpression, StateContext } from './types';
import {
  isNestedExpression,
  isPathValid,
  shouldSkipNode,
} from './utils/checks';
import {
  getForeignBindings,
  isForeignBinding,
} from './utils/get-foreign-bindings';
import { getHookCallType } from './utils/get-hook-call-type';
import { getImportIdentifier } from './utils/get-import-identifier';

function optimizedExpr(
  expr: t.Expression,
  deps?: t.Expression | t.Expression[],
  constant?: boolean,
): OptimizedExpression {
  return { expr, deps, constant };
}

function createDependencies(
  dependencies?: t.Expression | t.Expression[],
): t.Expression[] {
  if (dependencies) {
    if (Array.isArray(dependencies)) {
      return dependencies;
    }
    return [dependencies];
  }
  return [];
}

function mergeDependencies(
  target: t.Expression[],
  dependencies?: t.Expression | t.Expression[],
): void {
  if (dependencies) {
    if (Array.isArray(dependencies)) {
      target.push(...dependencies);
    } else {
      target.push(dependencies);
    }
  }
}

export default class Optimizer {
  ctx: StateContext;

  path: babel.NodePath<ComponentNode>;

  scope: OptimizerScope;

  nodeConstantCheckCache = new WeakMap<babel.NodePath<t.Expression>, boolean>();

  constructor(ctx: StateContext, path: babel.NodePath<ComponentNode>) {
    this.ctx = ctx;
    this.path = path;
    this.scope = new OptimizerScope(ctx, path);
  }

  /**
   * This method declares the memoized value
   * - if the dependencies is an expression, the expression is used
   *   as the memoization condition
   * - if the dependencies is an array, the array is combined with
   *   logical AND into a single expression
   * - if the dependencies is `true`, then this expression is to be
   *   memoized as a "constant" (aka one-time generation)
   * - if the dependencies is `false`, then it means that it is being
   *   used as a dependency and so it must be compared to its memoized
   *   version.
   */
  createMemo(
    current: t.Expression,
    dependencies?: t.Expression | (t.Expression | undefined)[] | boolean,
    type: 'memo' | 'ref' = 'memo',
  ): OptimizedExpression {
    // Check if the identifier is an already optimized
    // identifier so that we can skip it.
    if (current.type === 'Identifier') {
      const optimized = this.scope.getOptimized(current);
      if (optimized) {
        return optimized;
      }
    }
    // Creates the cache header
    const header = this.scope.isInLoop
      ? this.scope.createLoopHeader()
      : this.scope.createHeader(type);
    // Get the memo index
    const index = this.scope.createIndex(type);
    // Generate the access expression
    const pos = t.memberExpression(header, index, true);
    // Generate the `v` identifier
    const vid = this.path.scope.generateUidIdentifier('value');

    let condition: t.Expression | undefined;

    // Dependencies is an array of conditions
    if (Array.isArray(dependencies)) {
      // Makes sure to dedupe
      const newSet = new Set<t.Identifier>();
      let dependency: t.Expression | undefined;
      for (let i = 0, len = dependencies.length; i < len; i++) {
        dependency = dependencies[i];
        if (condition && dependency) {
          if (dependency.type === 'Identifier') {
            // dependency is already part of the condition, skip
            if (!newSet.has(dependency)) {
              condition = t.logicalExpression('&&', condition, dependency);
              newSet.add(dependency);
            }
          } else {
            condition = t.logicalExpression('&&', condition, dependency);
          }
        } else if (dependency) {
          condition = dependency;
          if (dependency.type === 'Identifier') {
            newSet.add(dependency);
          }
        }
      }
    } else if (dependencies === true) {
      // Do nothing
    } else if (dependencies) {
      // just reuse the dependency
      condition = dependencies;
    } else {
      // Compare memoized version to incoming version
      condition = t.callExpression(
        getImportIdentifier(this.ctx, this.path, RUNTIME_EQUALS),
        [header, index, current],
      );
    }

    let eqid: t.Expression;

    // Generates the condition expression
    if (condition == null) {
      // Specifies that this memoization mode
      // is a "constant"
      // so we don't need to generate an extra
      // declaration
      eqid = pos;
    } else if (condition.type === 'Identifier') {
      // Reuse the identifier
      eqid = condition;
    } else {
      // Generate a new identifier for the condition
      eqid = this.path.scope.generateUidIdentifier('equals');
    }

    // Generates the variable declaration
    const declaration: t.VariableDeclarator[] = [];
    if (condition && condition.type !== 'Identifier') {
      declaration.push(t.variableDeclarator(eqid, condition));
    }

    const optimized = optimizedExpr(vid, condition == null ? [] : eqid);
    // Register as a constant
    if (condition == null) {
      this.scope.addConstant(vid);
    }

    // Mark the identifier as optimized
    if (current.type === 'Identifier') {
      this.scope.setOptimized(current, optimized);
      this.scope.setOptimized(vid, optimized);
    }

    const init = t.conditionalExpression(
      condition ? eqid : t.binaryExpression('in', index, header),
      pos,
      t.assignmentExpression('=', pos, current),
    );

    declaration.push(t.variableDeclarator(vid, init));

    this.scope.push(t.variableDeclaration('let', declaration));

    return optimized;
  }

  dependency = new WeakMap<t.Expression, OptimizedExpression>();

  /**
   * Registers a dependency
   */
  createDependency<T extends t.Expression>(
    path: babel.NodePath<T>,
  ): OptimizedExpression | undefined {
    // Get optimized expression
    const optimized = this.optimizeExpression(path);
    // If the expression is a constant
    // ignore this dependency
    if (optimized.constant) {
      return undefined;
    }
    // If the expression is an identifier
    // and potentially optimized as a constant
    // then just return it
    if (
      optimized.expr.type === 'Identifier' &&
      this.scope.hasConstant(optimized.expr)
    ) {
      return optimized;
    }
    // If the node itself is a "dependency"
    // then this is basically redundant work, skipping
    const result = this.dependency.get(path.node);
    if (result) {
      return result;
    }
    // The value has been optimized but value isn't referentially
    // compared, so generate a referential-comparison memo
    const record = this.createMemo(optimized.expr, false);
    this.dependency.set(path.node, record);
    return record;
  }

  memoizeIdentifier(
    path: babel.NodePath,
    id: t.Identifier,
  ): OptimizedExpression {
    if (isForeignBinding(this.path, path, id.name)) {
      return optimizedExpr(id, [], true);
    }
    // Check if scope has the binding (no globals)
    // we only want to memoize identifiers
    // that are part of the render evaluation
    const binding = path.scope.getBindingIdentifier(id.name);
    if (binding) {
      // Memoize as a "dependency"
      return this.createMemo(binding, false);
    }
    // Identifier is marked as optimized
    // but we just basically "skip"
    return optimizedExpr(id, [], true);
  }

  optimizeIdentifier(path: babel.NodePath<t.Identifier>): OptimizedExpression {
    return this.memoizeIdentifier(path, path.node);
  }

  memoizeMemberExpression(path: babel.NodePath<t.MemberExpression>): {
    expr: t.MemberExpression;
    deps: t.Expression[];
  } {
    if (isConstant(this, path)) {
      return {
        expr: path.node,
        deps: [],
      };
    }
    // Create dependencies
    const condition = createDependencies();
    // Mark source as a dependency
    const source = this.createDependency(path.get('object'));
    if (source) {
      path.node.object = source.expr;
      mergeDependencies(condition, source.deps);
    }
    // Only memoize computed properties (obviously)
    if (path.node.computed) {
      const propertyPath = path.get('property');
      if (isPathValid(propertyPath, t.isExpression)) {
        const property = this.createDependency(propertyPath);
        if (property) {
          path.node.property = property.expr;
          mergeDependencies(condition, property.deps);
        }
      }
    }

    return {
      expr: path.node,
      deps: condition,
    };
  }

  optimizeMemberExpression(
    path: babel.NodePath<t.MemberExpression>,
  ): OptimizedExpression {
    const result = this.memoizeMemberExpression(path);
    // Memoize the entire expression as a whole
    // The method above only memoized part of the expression
    // but it is also needed to get its dependencies
    return this.createMemo(result.expr, result.deps);
  }

  optimizeConditionalExpression(
    path: babel.NodePath<t.ConditionalExpression>,
  ): OptimizedExpression {
    const id = path.scope.generateUidIdentifier('value');
    const parent = this.scope;
    const optimizedTest = this.optimizeExpression(path.get('test'));
    const consequentPath = path.get('consequent');
    const consequent = new OptimizerScope(this.ctx, consequentPath, parent);
    this.scope = consequent;
    const optimizedConsequent = this.optimizeExpression(consequentPath);
    this.scope = parent;
    const alternatePath = path.get('alternate');
    const alternate = new OptimizerScope(this.ctx, alternatePath, parent);
    this.scope = alternate;
    const optimizedAlternate = this.optimizeExpression(alternatePath);
    this.scope = parent;

    consequent.push(
      t.expressionStatement(
        t.assignmentExpression('=', id, optimizedConsequent.expr),
      ),
    );
    alternate.push(
      t.expressionStatement(
        t.assignmentExpression('=', id, optimizedAlternate.expr),
      ),
    );
    this.scope.push(
      t.variableDeclaration('let', [t.variableDeclarator(id)]),
      t.ifStatement(
        optimizedTest.expr,
        t.blockStatement(consequent.getStatements()),
        t.blockStatement(alternate.getStatements()),
      ),
    );

    return optimizedExpr(id);
  }

  optimizeBinaryExpression(
    path: babel.NodePath<t.BinaryExpression>,
  ): OptimizedExpression {
    if (path.node.operator === '|>') {
      return optimizedExpr(path.node);
    }
    const leftPath = path.get('left');

    const dependencies = createDependencies();

    if (isPathValid(leftPath, t.isExpression)) {
      const left = this.createDependency(leftPath);
      if (left) {
        path.node.left = left.expr;
        mergeDependencies(dependencies, left.deps);
      }
    }
    const right = this.createDependency(path.get('right'));
    if (right) {
      path.node.right = right.expr;
      mergeDependencies(dependencies, right.deps);
    }

    return this.createMemo(path.node, dependencies);
  }

  optimizeLogicalExpression(
    path: babel.NodePath<t.LogicalExpression>,
  ): OptimizedExpression {
    const id = path.scope.generateUidIdentifier('condition');
    const parent = this.scope;
    const left = this.optimizeExpression(path.get('left'));
    const rightScope = new OptimizerScope(this.ctx, path, parent);
    this.scope = rightScope;
    const right = this.optimizeExpression(path.get('right'));
    this.scope = parent;

    let test: t.Expression = id;
    switch (path.node.operator) {
      case '??': {
        test = t.binaryExpression('==', id, t.nullLiteral());
        break;
      }
      case '||': {
        test = t.unaryExpression('!', id);
        break;
      }
      default:
        break;
    }

    rightScope.push(
      t.expressionStatement(t.assignmentExpression('=', id, right.expr)),
    );

    this.scope.push(
      t.variableDeclaration('let', [t.variableDeclarator(id, left.expr)]),
      t.ifStatement(test, t.blockStatement(rightScope.getStatements())),
    );
    return optimizedExpr(id);
  }

  optimizeUnaryExpression(
    path: babel.NodePath<t.UnaryExpression>,
  ): OptimizedExpression {
    const optimized = this.createDependency(path.get('argument'));
    if (optimized) {
      path.node.argument = optimized.expr;
      return this.createMemo(path.node, optimized.deps);
    }
    return optimizedExpr(path.node);
  }

  optimizeEffect(path: babel.NodePath<t.CallExpression>): OptimizedExpression {
    const [callback, dependencies] = path.get('arguments');
    if (isPathValid(callback, t.isExpression)) {
      if (dependencies && isPathValid(dependencies, t.isExpression)) {
        const optimizedArray = this.optimizeExpression(dependencies);
        path.node.arguments[1] = t.arrayExpression([optimizedArray.expr]);
        return optimizedExpr(path.node, optimizedArray.deps);
      }
      const optimized = this.optimizeExpression(callback);
      path.node.arguments = [
        optimized.expr,
        t.arrayExpression([optimized.expr]),
      ];
      return optimizedExpr(path.node, optimized.deps);
    }
    return optimizedExpr(path.node);
  }

  optimizeCallback(
    path: babel.NodePath<t.CallExpression>,
  ): OptimizedExpression {
    const [callback, dependencies] = path.get('arguments');
    if (isPathValid(callback, t.isExpression)) {
      if (dependencies && isPathValid(dependencies, t.isExpression)) {
        const dependency = this.optimizeExpression(dependencies);
        return this.createMemo(callback.node, dependency.deps);
      }
      return this.optimizeExpression(callback);
    }
    return optimizedExpr(path.node);
  }

  optimizeMemo(path: babel.NodePath<t.CallExpression>): OptimizedExpression {
    const [callback, dependencies] = path.get('arguments');
    if (isPathValid(callback, t.isExpression)) {
      if (dependencies && isPathValid(dependencies, t.isExpression)) {
        const dependency = this.optimizeExpression(dependencies);
        return this.createMemo(
          t.callExpression(callback.node, []),
          dependency.deps,
        );
      }
      const optimized = this.optimizeExpression(callback);
      return this.createMemo(
        t.callExpression(optimized.expr, []),
        optimized.deps,
      );
    }
    return optimizedExpr(path.node);
  }

  optimizeRef(path: babel.NodePath<t.CallExpression>): OptimizedExpression {
    const arg = path.node.arguments[0];
    let init: t.Expression | undefined;
    if (arg) {
      switch (arg.type) {
        case 'SpreadElement': {
          init = t.memberExpression(arg.argument, t.numericLiteral(0), true);
          break;
        }
        case 'ArgumentPlaceholder':
        case 'JSXNamespacedName':
          break;
        default: {
          init = arg;
          break;
        }
      }
    }
    const expr = t.objectExpression([
      t.objectProperty(
        t.identifier('current'),
        init || t.unaryExpression('void', t.numericLiteral(0)),
      ),
    ]);
    return this.createMemo(expr, true, 'ref');
  }

  optimizeHookCallee(
    path: babel.NodePath<t.CallExpression>,
    condition: t.Expression[],
  ): void {
    const callee = path.get('callee');
    if (isPathValid(callee, t.isExpression)) {
      const optimizedCallee = isPathValid(callee, t.isMemberExpression)
        ? this.memoizeMemberExpression(callee)
        : this.createDependency(callee);
      if (optimizedCallee) {
        path.node.callee = optimizedCallee.expr;
        mergeDependencies(condition, optimizedCallee.deps);
      }
    }
  }

  optimizeSpreadElement(
    element: babel.NodePath<t.SpreadElement>,
    condition: t.Expression[],
  ): void {
    const optimized = this.createDependency(element.get('argument'));
    if (optimized) {
      mergeDependencies(condition, optimized.deps);
      element.node.argument = optimized.expr;
    }
  }

  optimizeHookArguments(
    path: babel.NodePath<t.CallExpression>,
    condition: t.Expression[],
  ): void {
    const argumentsPath = path.get('arguments');
    for (let i = 0, len = argumentsPath.length; i < len; i++) {
      const argument = argumentsPath[i];
      if (isPathValid(argument, t.isExpression)) {
        const optimized = this.createDependency(argument);
        if (optimized) {
          mergeDependencies(condition, optimized.deps);
          path.node.arguments[i] = optimized.expr;
        }
      } else if (isPathValid(argument, t.isSpreadElement)) {
        this.optimizeSpreadElement(argument, condition);
      }
    }
  }

  optimizeCustomHookCall(
    path: babel.NodePath<t.CallExpression>,
    hookType: 'custom' | 'none',
  ): OptimizedExpression {
    // Build dependencies
    const condition = createDependencies();
    if (hookType === 'none') {
      this.optimizeHookCallee(path, condition);
    }
    this.optimizeHookArguments(path, condition);
    if (hookType === 'custom') {
      return optimizedExpr(path.node, condition);
    }
    return this.createMemo(path.node, condition);
  }

  optimizeCallExpression(
    path: babel.NodePath<t.CallExpression>,
  ): OptimizedExpression {
    const hookType = getHookCallType(this.ctx, path);
    switch (hookType) {
      case 'callback':
        return this.optimizeCallback(path);
      case 'effect':
        return this.optimizeEffect(path);
      case 'memo':
        return this.optimizeMemo(path);
      case 'ref':
        return this.optimizeRef(path);
      case 'custom':
      case 'none':
        return this.optimizeCustomHookCall(path, hookType);
      default:
        return optimizedExpr(path.node);
    }
  }

  optimizeFunctionExpression(
    path: babel.NodePath<t.ArrowFunctionExpression | t.FunctionExpression>,
  ): OptimizedExpression {
    const bindings = getForeignBindings(path);
    const dependencies = createDependencies();
    let binding: t.Identifier;
    for (let i = 0, len = bindings.length; i < len; i++) {
      binding = bindings[i];
      const optimized = this.memoizeIdentifier(path, binding);
      mergeDependencies(dependencies, optimized.deps);
    }
    return this.createMemo(path.node, dependencies);
  }

  optimizeLVal(
    path: babel.NodePath<t.LVal>,
    dirty = false,
  ): { expr: t.LVal; deps?: t.Expression | t.Expression[] } {
    if (isPathValid(path, t.isIdentifier)) {
      if (dirty) {
        const binding = path.scope.getBindingIdentifier(path.node.name);
        if (binding) {
          // Variable has been modified, marked as dirty
          this.scope.deleteOptimized(binding);
        }
      }
    }
    if (isPathValid(path, t.isMemberExpression)) {
      return this.memoizeMemberExpression(path);
    }
    // TODO Destructuring
    return {
      expr: path.node,
      deps: [],
    };
  }

  optimizeAssignmentExpression(
    path: babel.NodePath<t.AssignmentExpression>,
  ): OptimizedExpression {
    const leftNode = path.get('left');
    if (isPathValid(leftNode, t.isLVal)) {
      const dependencies = createDependencies();
      const left = this.optimizeLVal(leftNode, true);
      path.node.left = left.expr;
      mergeDependencies(dependencies, left.deps);

      const right = this.createDependency(path.get('right'));
      if (right) {
        path.node.right = right.expr;
        mergeDependencies(dependencies, right.deps);
      }
      return optimizedExpr(path.node, dependencies);
    }
    return optimizedExpr(path.node);
  }

  optimizeArrayExpression(
    path: babel.NodePath<t.ArrayExpression | t.TupleExpression>,
  ): OptimizedExpression {
    const condition = createDependencies();
    const elementsPath = path.get('elements');

    for (let i = 0, len = elementsPath.length; i < len; i++) {
      const element = elementsPath[i];

      if (isPathValid(element, t.isExpression)) {
        const optimized = this.createDependency(element);
        if (optimized) {
          mergeDependencies(condition, optimized.deps);
          path.node.elements[i] = optimized.expr;
        }
      } else if (isPathValid(element, t.isSpreadElement)) {
        this.optimizeSpreadElement(element, condition);
      }
    }
    return this.createMemo(path.node, condition);
  }

  optimizeObjectProperty(
    element: babel.NodePath<t.ObjectProperty>,
    condition: t.Expression[],
  ): void {
    if (element.node.computed) {
      const keyPath = element.get('key');

      if (isPathValid(keyPath, t.isExpression)) {
        const optimized = this.createDependency(keyPath);
        if (optimized) {
          mergeDependencies(condition, optimized.deps);
          element.node.key = optimized.expr;
        }
      }
    }
    const valuePath = element.get('value');

    if (isPathValid(valuePath, t.isExpression)) {
      const optimized = this.createDependency(valuePath);
      if (optimized) {
        mergeDependencies(condition, optimized.deps);
        element.node.value = optimized.expr;
      }
    }
  }

  optimizeObjectExpression(
    path: babel.NodePath<t.ObjectExpression | t.RecordExpression>,
  ): OptimizedExpression {
    const condition = createDependencies();
    const elementsPath = path.get('properties');

    for (let i = 0, len = elementsPath.length; i < len; i++) {
      const element = elementsPath[i];
      if (isPathValid(element, t.isObjectProperty)) {
        this.optimizeObjectProperty(element, condition);
      } else if (isPathValid(element, t.isSpreadElement)) {
        this.optimizeSpreadElement(element, condition);
      } else if (isPathValid(element, t.isObjectMethod)) {
        const bindings = getForeignBindings(path);
        const dependencies = createDependencies();
        let binding: t.Identifier;
        for (let k = 0, klen = bindings.length; k < klen; k++) {
          binding = bindings[k];
          const optimized = this.memoizeIdentifier(path, binding);
          mergeDependencies(dependencies, optimized.deps);
        }
        mergeDependencies(condition, dependencies);
      }
    }

    return this.createMemo(path.node, condition);
  }

  optimizeNewExpression(
    path: babel.NodePath<t.NewExpression>,
  ): OptimizedExpression {
    const calleePath = path.get('callee');
    if (isPathValid(calleePath, t.isExpression)) {
      // Build dependencies
      const condition = createDependencies();
      const callee = this.createDependency(calleePath);
      if (callee) {
        path.node.callee = callee.expr;
        mergeDependencies(condition, callee.deps);
      }
      const argumentsPath = path.get('arguments');
      let argument: (typeof argumentsPath)[0];
      for (let i = 0, len = argumentsPath.length; i < len; i++) {
        argument = argumentsPath[i];
        if (isPathValid(argument, t.isExpression)) {
          const optimized = this.createDependency(argument);
          if (optimized) {
            mergeDependencies(condition, optimized.deps);
            path.node.arguments[i] = optimized.expr;
          }
        } else if (isPathValid(argument, t.isSpreadElement)) {
          this.optimizeSpreadElement(argument, condition);
        }
      }
      return this.createMemo(path.node, condition);
    }
    return optimizedExpr(path.node);
  }

  optimizeSequenceExpression(
    path: babel.NodePath<t.SequenceExpression>,
  ): OptimizedExpression {
    const expressions = path.get('expressions');
    let expr: (typeof expressions)[0];
    for (let i = 0, len = expressions.length; i < len; i++) {
      expr = expressions[i];
      const result = this.optimizeExpression(expr);
      path.node.expressions[i] = result.expr;
    }
    return optimizedExpr(path.node);
  }

  memoizeTemplateLiteral(path: babel.NodePath<t.TemplateLiteral>): {
    expr: t.TemplateLiteral;
    deps: t.Expression[];
  } {
    const conditions = createDependencies();
    const expressions = path.get('expressions');
    let expr: (typeof expressions)[0];
    for (let i = 0, len = expressions.length; i < len; i++) {
      expr = expressions[i];
      if (isPathValid(expr, t.isExpression)) {
        const dependency = this.createDependency(expr);
        if (dependency) {
          path.node.expressions[i] = dependency.expr;
          mergeDependencies(conditions, dependency.deps);
        }
      }
    }
    return {
      expr: path.node,
      deps: conditions,
    };
  }

  optimizeTemplateLiteral(
    path: babel.NodePath<t.TemplateLiteral>,
  ): OptimizedExpression {
    const result = this.memoizeTemplateLiteral(path);
    return this.createMemo(result.expr, result.deps);
  }

  optimizedTaggedTemplateExpression(
    path: babel.NodePath<t.TaggedTemplateExpression>,
  ): OptimizedExpression {
    const conditions = createDependencies();
    const tag = this.createDependency(path.get('tag'));
    if (tag) {
      mergeDependencies(conditions, tag.deps);
      path.node.tag = tag.expr;
    }
    const quasi = this.memoizeTemplateLiteral(path.get('quasi'));
    mergeDependencies(conditions, quasi.deps);
    path.node.quasi = quasi.expr;

    return this.createMemo(path.node, conditions);
  }

  memoizeJSXExpressionContainer(
    child: babel.NodePath<t.JSXExpressionContainer>,
    conditions: t.Expression[],
  ): void {
    const expr = child.get('expression');
    if (isPathValid(expr, t.isExpression)) {
      const optimized = this.createDependency(expr);
      if (optimized) {
        child.node.expression = optimized.expr;
        mergeDependencies(conditions, optimized.deps);
      }
    }
  }

  memoizeJSXSpreadChild(
    child: babel.NodePath<t.JSXSpreadChild>,
    conditions: t.Expression[],
  ): void {
    const optimized = this.createDependency(child.get('expression'));
    if (optimized) {
      child.node.expression = optimized.expr;
      mergeDependencies(conditions, optimized.deps);
    }
  }

  memoizeJSXChildren(
    path: babel.NodePath<t.JSXFragment | t.JSXElement>,
  ): t.Expression[] {
    const conditions = createDependencies();
    const children = path.get('children');
    for (let i = 0, len = children.length; i < len; i++) {
      const child = children[i];
      if (isPathValid(child, t.isJSXFragment)) {
        const optimized = this.createDependency(child);
        if (optimized) {
          path.node.children[i] = t.jsxExpressionContainer(optimized.expr);
          mergeDependencies(conditions, optimized.deps);
        }
      } else if (isPathValid(child, t.isJSXElement)) {
        const optimized = this.createDependency(child);
        if (optimized) {
          path.node.children[i] = t.jsxExpressionContainer(optimized.expr);
          mergeDependencies(conditions, optimized.deps);
        }
      } else if (isPathValid(child, t.isJSXExpressionContainer)) {
        this.memoizeJSXExpressionContainer(child, conditions);
      } else if (isPathValid(child, t.isJSXSpreadChild)) {
        this.memoizeJSXSpreadChild(child, conditions);
      }
    }

    return conditions;
  }

  optimizeJSXFragment(
    path: babel.NodePath<t.JSXFragment>,
  ): OptimizedExpression {
    if (this.ctx.preset.runtime.memo) {
      const dependencies = this.memoizeJSXChildren(path);
      return this.createMemo(path.node, dependencies);
    }
    return optimizedExpr(path.node);
  }

  optimizeJSXAttribute(
    attribute: babel.NodePath<t.JSXAttribute>,
    dependencies: t.Expression[],
  ): void {
    const value = attribute.get('value');
    if (value) {
      if (isPathValid(value, t.isJSXFragment)) {
        const optimized = this.createDependency(value);
        if (optimized) {
          attribute.node.value = t.jsxExpressionContainer(optimized.expr);
          mergeDependencies(dependencies, optimized.deps);
        }
      } else if (isPathValid(value, t.isJSXElement)) {
        const optimized = this.createDependency(value);
        if (optimized) {
          attribute.node.value = t.jsxExpressionContainer(optimized.expr);
          mergeDependencies(dependencies, optimized.deps);
        }
      } else if (isPathValid(value, t.isJSXExpressionContainer)) {
        this.memoizeJSXExpressionContainer(value, dependencies);
      }
    }
  }

  optimizeJSXAttributes(
    attributes: babel.NodePath<
      babel.types.JSXAttribute | babel.types.JSXSpreadAttribute
    >[],
  ): t.Expression[] {
    const dependencies = createDependencies();
    for (let i = 0, len = attributes.length; i < len; i++) {
      const attribute = attributes[i];
      if (isPathValid(attribute, t.isJSXAttribute)) {
        this.optimizeJSXAttribute(attribute, dependencies);
      } else if (isPathValid(attribute, t.isJSXSpreadAttribute)) {
        const optimized = this.createDependency(attribute.get('argument'));
        if (optimized) {
          attribute.node.argument = optimized.expr;
          mergeDependencies(dependencies, optimized.deps);
        }
      }
    }
    return dependencies;
  }

  optimizeJSXElement(path: babel.NodePath<t.JSXElement>): OptimizedExpression {
    if (this.ctx.preset.runtime.memo) {
      const attributes = path.get('openingElement').get('attributes');
      const dependencies = this.optimizeJSXAttributes(attributes);
      if (path.node.children.length) {
        mergeDependencies(dependencies, this.memoizeJSXChildren(path));
      }
      return this.createMemo(path.node, dependencies);
    }
    return optimizedExpr(path.node);
  }

  optimizeExpression(path: babel.NodePath<t.Expression>): OptimizedExpression {
    if (shouldSkipNode(path.node)) {
      return optimizedExpr(path.node, undefined, true);
    }
    if (isPathValid(path, isNestedExpression)) {
      return this.optimizeExpression(path.get('expression'));
    }
    // No need to optimize
    if (t.isLiteral(path.node) && path.node.type !== 'TemplateLiteral') {
      return optimizedExpr(path.node, undefined, true);
    }
    // Only optimize for complex values
    if (isConstant(this, path)) {
      return this.createMemo(path.node, true);
    }
    if (isPathValid(path, t.isIdentifier)) {
      return this.optimizeIdentifier(path);
    }
    if (isPathValid(path, t.isMemberExpression)) {
      return this.optimizeMemberExpression(path);
    }
    if (isPathValid(path, t.isConditionalExpression)) {
      return this.optimizeConditionalExpression(path);
    }
    if (isPathValid(path, t.isBinaryExpression)) {
      return this.optimizeBinaryExpression(path);
    }
    if (isPathValid(path, t.isLogicalExpression)) {
      return this.optimizeLogicalExpression(path);
    }
    if (isPathValid(path, t.isUnaryExpression)) {
      return this.optimizeUnaryExpression(path);
    }
    if (isPathValid(path, t.isCallExpression)) {
      return this.optimizeCallExpression(path);
    }
    if (
      isPathValid(path, t.isFunctionExpression) ||
      isPathValid(path, t.isArrowFunctionExpression)
    ) {
      return this.optimizeFunctionExpression(path);
    }
    if (isPathValid(path, t.isAssignmentExpression)) {
      return this.optimizeAssignmentExpression(path);
    }
    if (
      isPathValid(path, t.isArrayExpression) ||
      isPathValid(path, t.isTupleExpression)
    ) {
      return this.optimizeArrayExpression(path);
    }
    if (
      isPathValid(path, t.isObjectExpression) ||
      isPathValid(path, t.isRecordExpression)
    ) {
      return this.optimizeObjectExpression(path);
    }
    if (isPathValid(path, t.isNewExpression)) {
      return this.optimizeNewExpression(path);
    }
    if (isPathValid(path, t.isSequenceExpression)) {
      return this.optimizeSequenceExpression(path);
    }
    if (isPathValid(path, t.isTaggedTemplateExpression)) {
      return this.optimizedTaggedTemplateExpression(path);
    }
    if (isPathValid(path, t.isTemplateLiteral)) {
      return this.optimizeTemplateLiteral(path);
    }
    if (isPathValid(path, t.isJSXFragment)) {
      return this.optimizeJSXFragment(path);
    }
    if (isPathValid(path, t.isJSXElement)) {
      return this.optimizeJSXElement(path);
    }
    return optimizedExpr(path.node, undefined, true);
  }

  optimizeExpressionStatement(
    path: babel.NodePath<t.ExpressionStatement>,
  ): void {
    const expr = path.get('expression');
    const optimized = this.optimizeExpression(expr);
    expr.replaceWith(optimized.expr);
  }

  optimizeVariableDeclaration(
    path: babel.NodePath<t.VariableDeclaration>,
  ): void {
    const declarations = path.get('declarations');
    let declaration: (typeof declarations)[0];
    for (let i = 0, len = declarations.length; i < len; i++) {
      declaration = declarations[i];
      const init = declaration.node.init
        ? this.optimizeExpression(
            declaration.get('init') as babel.NodePath<t.Expression>,
          ).expr
        : undefined;
      this.scope.push(
        t.variableDeclaration(path.node.kind, [
          t.variableDeclarator(declaration.node.id, init),
        ]),
      );
    }
  }

  optimizeReturnStatement(path: babel.NodePath<t.ReturnStatement>): void {
    if (path.node.argument) {
      const argument = path.get('argument') as babel.NodePath<t.Expression>;
      const optimized = this.optimizeExpression(argument);
      argument.replaceWith(optimized.expr);
    }
  }

  optimizeThrowStatement(path: babel.NodePath<t.ThrowStatement>): void {
    const argument = path.get('argument');
    const optimized = this.optimizeExpression(argument);
    argument.replaceWith(optimized.expr);
  }

  private optimizeBlock(path: babel.NodePath<t.BlockStatement>): void {
    if (shouldSkipNode(path.node)) {
      return;
    }
    const statements = path.get('body');
    for (let i = 0, len = statements.length; i < len; i++) {
      this.optimizeStatement(statements[i], false);
    }
  }

  optimizeBlockStatement(
    path: babel.NodePath<t.BlockStatement>,
    topBlock = false,
  ): void {
    if (topBlock) {
      this.optimizeBlock(path);
    } else {
      const parent = this.scope;
      const block = new OptimizerScope(this.ctx, path, parent);
      this.scope = block;
      this.optimizeBlock(path);
      this.scope = parent;
      this.scope.push(t.blockStatement(block.getStatements()));
    }
  }

  optimizeIfStatement(path: babel.NodePath<t.IfStatement>): void {
    const optimized = this.optimizeExpression(path.get('test'));
    const parent = this.scope;
    const consequentPath = path.get('consequent');
    const consequent = new OptimizerScope(this.ctx, consequentPath, parent);
    this.scope = consequent;
    this.optimizeStatement(consequentPath, true);
    this.scope = parent;
    const newNode = t.ifStatement(
      optimized.expr,
      t.blockStatement(consequent.getStatements()),
    );
    if (path.node.alternate) {
      const alternatePath = path.get(
        'alternate',
      ) as babel.NodePath<t.Statement>;
      const alternate = new OptimizerScope(this.ctx, alternatePath, parent);
      this.scope = alternate;
      this.optimizeStatement(alternatePath, true);
      this.scope = parent;
      newNode.alternate = t.blockStatement(alternate.getStatements());
    }
    this.scope.push(newNode);
  }

  optimizeLoopStatement(path: babel.NodePath<t.Loop>): void {
    const body = path.get('body');
    const parent = this.scope;
    const loop = new OptimizerScope(this.ctx, path, parent, true);
    this.scope = loop;
    this.optimizeStatement(body, true);
    this.scope = parent;

    const statements = loop.getStatements();

    const memoDeclaration = loop.getLoopMemoDeclaration();
    if (memoDeclaration) {
      this.scope.push(memoDeclaration);
    }

    body.replaceWith(t.blockStatement(statements));
  }

  optimizeForXStatement(path: babel.NodePath<t.ForXStatement>): void {
    const right = path.get('right');
    const optimized = this.optimizeExpression(right);
    right.replaceWith(optimized.expr);
    this.optimizeLoopStatement(path);
  }

  optimizeSwitchStatement(path: babel.NodePath<t.SwitchStatement>): void {
    const discriminant = path.get('discriminant');
    const newDiscriminant = this.optimizeExpression(discriminant);
    discriminant.replaceWith(newDiscriminant.expr);

    const parent = this.scope;
    const cases = path.get('cases');
    let current: (typeof cases)[0];
    for (let i = 0, len = cases.length; i < len; i++) {
      current = cases[i];
      const scope = new OptimizerScope(parent.ctx, current, parent);
      this.scope = scope;
      const consequents = current.get('consequent');
      for (let k = 0, klen = consequents.length; k < klen; k++) {
        this.optimizeStatement(consequents[k], false);
      }
      this.scope = parent;
      current.node.consequent = scope.getStatements();
    }
    this.scope = parent;
  }

  optimizeTryStatement(path: babel.NodePath<t.TryStatement>): void {
    const block = path.get('block');
    const parent = this.scope;
    const tryBlock = new OptimizerScope(this.ctx, path, parent);
    this.scope = tryBlock;
    this.optimizeBlock(block);
    this.scope = parent;
    block.replaceWith(t.blockStatement(tryBlock.getStatements()));

    if (path.node.handler) {
      const handler = path.get('handler') as babel.NodePath<t.CatchClause>;
      const body = handler.get('body');
      const catchClause = new OptimizerScope(this.ctx, handler, parent);
      this.scope = catchClause;
      this.optimizeBlock(body);
      this.scope = parent;
      body.replaceWith(t.blockStatement(catchClause.getStatements()));
    }
    if (path.node.finalizer) {
      const handler = path.get('finalizer') as babel.NodePath<t.BlockStatement>;
      const finalizerBlock = new OptimizerScope(this.ctx, handler, parent);
      this.scope = finalizerBlock;
      this.optimizeBlock(handler);
      this.scope = parent;
      handler.replaceWith(t.blockStatement(finalizerBlock.getStatements()));
    }
  }

  optimizeLabeledStatement(path: babel.NodePath<t.LabeledStatement>): void {
    const body = path.get('body');
    const parent = this.scope;
    const block = new OptimizerScope(this.ctx, path, parent);
    this.scope = block;
    this.optimizeStatement(body, false);
    this.scope = parent;
    body.replaceWith(t.blockStatement(block.getStatements()));
  }

  optimizeStatement(
    path: babel.NodePath<t.Statement>,
    topBlock: boolean,
  ): void {
    if (shouldSkipNode(path.node)) {
      return;
    }
    if (isPathValid(path, t.isExpressionStatement)) {
      this.optimizeExpressionStatement(path);
    } else if (isPathValid(path, t.isVariableDeclaration)) {
      this.optimizeVariableDeclaration(path);
      return;
    } else if (isPathValid(path, t.isReturnStatement)) {
      this.optimizeReturnStatement(path);
    } else if (isPathValid(path, t.isThrowStatement)) {
      this.optimizeThrowStatement(path);
    } else if (isPathValid(path, t.isBlockStatement)) {
      this.optimizeBlockStatement(path, topBlock);
      return;
    } else if (isPathValid(path, t.isIfStatement)) {
      this.optimizeIfStatement(path);
      return;
    } else if (isPathValid(path, t.isForXStatement)) {
      this.optimizeForXStatement(path);
    } else if (isPathValid(path, t.isLoop)) {
      this.optimizeLoopStatement(path);
    } else if (isPathValid(path, t.isSwitchStatement)) {
      this.optimizeSwitchStatement(path);
    } else if (isPathValid(path, t.isTryStatement)) {
      this.optimizeTryStatement(path);
    } else if (isPathValid(path, t.isLabeledStatement)) {
      this.optimizeLabeledStatement(path);
    }
    this.scope.push(path.node);
  }

  optimizeArrowComponent(
    path: babel.NodePath<t.ArrowFunctionExpression>,
  ): void {
    path.node.body = t.isStatement(path.node.body)
      ? path.node.body
      : t.blockStatement([t.returnStatement(path.node.body)]);
    const body = path.get('body');
    this.optimizeBlock(body as babel.NodePath<t.BlockStatement>);
    body.replaceWith(t.blockStatement(this.scope.getStatements()));
  }

  optimizeFunctionComponent(
    path: babel.NodePath<t.FunctionExpression | t.FunctionDeclaration>,
  ): void {
    const body = path.get('body');
    this.optimizeBlock(body);
    body.replaceWith(t.blockStatement(this.scope.getStatements()));
  }

  optimize(): void {
    if (isPathValid(this.path, t.isArrowFunctionExpression)) {
      this.optimizeArrowComponent(this.path);
    } else {
      this.optimizeFunctionComponent(
        this.path as babel.NodePath<
          t.FunctionExpression | t.FunctionDeclaration
        >,
      );
    }
    this.path.scope.crawl();
  }
}
