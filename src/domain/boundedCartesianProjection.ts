/** Project a Cartesian product without materializing values beyond the output limit. */
export const projectBoundedCartesian = <Left, Right, Value>(
  left: readonly Left[],
  right: readonly Right[],
  maximum: number,
  project: (left: Left, right: Right) => Value,
): { readonly values: Value[]; readonly omitted: number } => {
  const values: Value[] = [];
  for (const leftValue of left) {
    for (const rightValue of right) {
      if (values.length === maximum)
        return {
          values,
          omitted: left.length * right.length - values.length,
        };
      values.push(project(leftValue, rightValue));
    }
  }
  return { values, omitted: 0 };
};
