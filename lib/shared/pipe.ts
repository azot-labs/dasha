type Fn = (...args: any[]) => any;

type FirstArgumentType<F extends Fn[]> = F extends [infer Last extends Fn, ...any]
  ? Parameters<Last>[0]
  : never;

type LastReturnType<L extends Fn[]> = L extends [...any, infer Last extends Fn]
  ? ReturnType<Last>
  : never;

export const pipe =
  <Funcs extends Fn[]>(...fns: Funcs) =>
  (value: FirstArgumentType<Funcs>) =>
    fns.reduce((acc, fn) => fn(acc), value) as LastReturnType<Funcs>;
