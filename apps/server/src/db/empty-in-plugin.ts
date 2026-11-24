import {
  BinaryOperationNode,
  OperationNodeTransformer,
  OperatorNode,
  PrimitiveValueListNode,
  ValueListNode,
  ValueNode,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

/**
 * `x in ()` is valid SQLite but a syntax error in Postgres. Rewrites an empty `in` list to
 * `1 = 0` and an empty `not in` list to `1 = 1`, so `.where('id', 'in', ids)` is safe for any
 * `ids` on both dialects.
 */
class EmptyInListTransformer extends OperationNodeTransformer {
  protected override transformBinaryOperation(node: BinaryOperationNode): BinaryOperationNode {
    const op = OperatorNode.is(node.operator) ? node.operator.operator : undefined;
    if ((op === 'in' || op === 'not in') && isEmptyList(node.rightOperand)) {
      return BinaryOperationNode.create(ValueNode.createImmediate(1), OperatorNode.create('='), ValueNode.createImmediate(op === 'in' ? 0 : 1));
    }
    return super.transformBinaryOperation(node);
  }
}

function isEmptyList(node: BinaryOperationNode['rightOperand']): boolean {
  return (PrimitiveValueListNode.is(node) || ValueListNode.is(node)) && node.values.length === 0;
}

export class EmptyInListPlugin implements KyselyPlugin {
  readonly #transformer = new EmptyInListTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
