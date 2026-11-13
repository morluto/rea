/** Inert generated Webpack source; no fixture code is executed. */
export const javascriptAsyncChunkCapacity = (count: number) => {
  const factory = `(m,e,r)=>{${Array.from(
    { length: count },
    (_, index) => `r.e(${String(index)});`,
  ).join("")}}`;
  return {
    factory,
    source:
      `self.webpackChunkapp.push([[1],{1:${factory},` +
      "2:(m,e,r)=>{r.e(0);r.e('later');r.e(dynamic);}}]);",
  };
};
