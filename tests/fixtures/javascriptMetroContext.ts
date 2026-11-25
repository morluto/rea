/** File keys in the getter map emitted by Metro's bundled require.context. */
export const metroContext = (keys: readonly string[]): string => {
  const entries = keys.map((key, index) => {
    const load = `r(d[${index}])`;
    const getter =
      index % 2 === 0 ? `get(){return ${load}}` : `get:()=>${load}`;
    return `${JSON.stringify(key)}:{enumerable:!0,${getter}}`;
  });
  return `__d(function(g,r,i,a,m,e,d){const t=Object.defineProperties({},{${entries.join(
    ",",
  )}});function n(e){return t[e]}n.keys=function(){return Object.keys(t)},m.exports=n},512,[]);`;
};
