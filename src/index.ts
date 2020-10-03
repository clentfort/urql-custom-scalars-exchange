import { Exchange } from '@urql/core';
import { pipe, map } from 'wonka';
import {
  ASTNode,
  DocumentNode,
  FieldNode,
  GraphQLOutputType,
  GraphQLScalarType,
  IntrospectionQuery,
  TypeInfo,
  buildClientSchema,
  isListType,
  isNonNullType,
  isScalarType,
  visit,
  visitWithTypeInfo,
} from 'graphql';

type ScalarMapper = (input: any) => any;
type ScalarMappings = Record<string, ScalarMapper>;
type ScalarInData = {
  name: string;
  path: PropertyKey[];
};

function isDocumentNode(
  maybeNodeArray: ASTNode | ReadonlyArray<ASTNode>
): maybeNodeArray is DocumentNode {
  if (Array.isArray(maybeNodeArray)) {
    return false;
  }
  const node: ASTNode = maybeNodeArray as ASTNode;
  return node.kind === 'Document';
}

function isFieldNode(
  maybeNodeArray: ASTNode | ReadonlyArray<ASTNode>
): maybeNodeArray is FieldNode {
  if (Array.isArray(maybeNodeArray)) {
    return false;
  }
  const node: ASTNode = maybeNodeArray as ASTNode;
  return node.kind === 'Field';
}

function mapScalars(data: any, path: PropertyKey[], map: ScalarMapper) {
  if (data == null) {
    return data;
  }

  const newData = { ...data };

  let newSubData = newData;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(newSubData[segment])) {
      const subPath = path.slice(index + 1);
      newSubData[segment] = newSubData[segment].map((subData: unknown) =>
        mapScalars(subData, subPath, map)
      );
      return newData;
    } else {
      newSubData[segment] = { ...newSubData[segment] };
    }
    newSubData = newSubData[segment];
  }

  const finalSegment = path[path.length - 1];

  if (Array.isArray(newSubData[finalSegment])) {
    newSubData[finalSegment] = newSubData[finalSegment].map(map);
  } else if (newSubData[finalSegment] != null) {
    newSubData[finalSegment] = map(newSubData[finalSegment]);
  }

  return newData;
}

interface ScalarExchangeOptions {
  scalars: ScalarMappings;
  schema: IntrospectionQuery;
}

function unpackTypeInner(type: GraphQLOutputType): GraphQLOutputType | void {
  if (isListType(type) || isNonNullType(type)) {
    return unpackTypeInner(type.ofType);
  }

  if (isScalarType(type)) {
    return type;
  }

  return;
}

function unpackType(type: GraphQLOutputType): GraphQLScalarType | void {
  return unpackTypeInner(type) as GraphQLScalarType | void;
}

export default function scalarExchange({
  schema,
  scalars,
}: ScalarExchangeOptions): Exchange {
  const clientSchema = buildClientSchema(schema);
  const typeInfoInstance = new TypeInfo(clientSchema);
  const makeVisitor = (scalarMappings: ScalarInData[]) =>
    visitWithTypeInfo(typeInfoInstance, {
      Field(_node, _key, _parent, astPath, anchestorAstNodes) {
        const fieldType = typeInfoInstance.getType();
        if (fieldType == null) {
          return;
        }

        const scalarType = unpackType(fieldType);
        if (scalarType == null) {
          return;
        }

        const { name } = scalarType;

        if (scalars[name] == null) {
          return;
        }

        let currentAstNode = anchestorAstNodes[0];
        if (!isDocumentNode(currentAstNode)) {
          throw new Error('Root node is not of type DocumentNode');
        }

        const dataPath: PropertyKey[] = [];
        for (const segment of astPath) {
          // @ts-ignore
          currentAstNode = currentAstNode[segment];
          if (isFieldNode(currentAstNode)) {
            const fieldNode = currentAstNode as FieldNode;
            if (fieldNode.alias) {
              dataPath.push(fieldNode.alias.value);
            } else {
              dataPath.push(fieldNode.name.value);
            }
          }
        }

        scalarMappings.push({
          name,
          path: dataPath,
        });
      },
    });

  return ({ forward }) => (operations$: any) => {
    const operationResult$ = forward(operations$);
    return pipe(
      operationResult$,
      map(args => {
        if (args.data == null) {
          return args;
        }
        const scalarMappings: ScalarInData[] = [];
        visit(args.operation.query, makeVisitor(scalarMappings));

        if (scalarMappings.length === 0) {
          return args;
        }

        for (const { path, name } of scalarMappings) {
          args.data = mapScalars(args.data, path, scalars[name]);
        }

        return args;
      })
    );
  };
}
