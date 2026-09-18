import type { ReadParam } from "./read-job";

export type SqlParam = ReadParam;

const SQL_FRAGMENT_TOKEN: unique symbol = Symbol("SqlFragment");

/** Immutable SQL text plus positional parameters. */
export class SqlFragment {
  readonly text: string;
  readonly params: readonly SqlParam[];

  constructor(
    token: typeof SQL_FRAGMENT_TOKEN,
    text: string,
    params: readonly SqlParam[],
  ) {
    if (token !== SQL_FRAGMENT_TOKEN) {
      throw new TypeError("SqlFragment constructor is internal");
    }
    this.text = text;
    this.params = Object.freeze([...params]);
    Object.freeze(this);
  }
}

function fragment(text: string, params: readonly SqlParam[] = []): SqlFragment {
  return new SqlFragment(SQL_FRAGMENT_TOKEN, text, params);
}

function isEmpty(value: SqlFragment): boolean {
  return value.text === "" && value.params.length === 0;
}

export function sql(
  strings: TemplateStringsArray,
  ...values: (SqlParam | SqlFragment)[]
): SqlFragment {
  let text = strings[0] ?? "";
  const params: SqlParam[] = [];

  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === undefined) {
      throw new TypeError("undefined cannot be interpolated into SQL");
    }
    if (value instanceof SqlFragment) {
      text += value.text;
      params.push(...value.params);
    } else {
      text += "?";
      params.push(value);
    }
    text += strings[index + 1] ?? "";
  }

  return fragment(text, params);
}

export namespace sql {
  /** Trusted SQL text from a code-owned allowlist; never pass user input. */
  export function raw(text: string): SqlFragment {
    return fragment(text);
  }

  export const empty = fragment("");

  export function join(
    fragments: readonly SqlFragment[],
    separator: string,
  ): SqlFragment {
    const nonEmpty = fragments.filter((value) => !isEmpty(value));
    if (nonEmpty.length === 0) return empty;

    const text: string[] = [];
    const params: SqlParam[] = [];
    for (const [index, value] of nonEmpty.entries()) {
      if (index > 0) text.push(separator);
      text.push(value.text);
      params.push(...value.params);
    }
    return fragment(text.join(""), params);
  }

  export function and(
    fragments: readonly (SqlFragment | null | undefined | false)[],
  ): SqlFragment {
    const nonEmpty = fragments.filter(
      (value): value is SqlFragment =>
        value != null && value !== false && !isEmpty(value),
    );
    if (nonEmpty.length === 0) return raw("1");
    return join(
      nonEmpty.map((value) => fragment(`(${value.text})`, value.params)),
      " AND ",
    );
  }

  export function or(
    fragments: readonly (SqlFragment | null | undefined | false)[],
  ): SqlFragment {
    const nonEmpty = fragments.filter(
      (value): value is SqlFragment =>
        value != null && value !== false && !isEmpty(value),
    );
    if (nonEmpty.length === 0) return raw("0");
    return join(
      nonEmpty.map((value) => fragment(`(${value.text})`, value.params)),
      " OR ",
    );
  }

  export function inList(values: readonly SqlParam[]): SqlFragment {
    if (values.length === 0) return raw("IN (SELECT NULL WHERE 0)");
    return fragment(`IN (${values.map(() => "?").join(", ")})`, values);
  }

  export const all = runAll;
  export const get = runGet;
  export const run = runFragment;
}

export function all<T = Record<string, unknown>>(
  dbLike: {
    query(sql: string): {
      all(...params: unknown[]): unknown[];
    };
  },
  frag: SqlFragment,
): T[] {
  return dbLike.query(frag.text).all(...frag.params) as T[];
}

export function get<T = Record<string, unknown>>(
  dbLike: {
    query(sql: string): {
      get(...params: unknown[]): unknown;
    };
  },
  frag: SqlFragment,
): T | null {
  return (dbLike.query(frag.text).get(...frag.params) ?? null) as T | null;
}

export function run(
  dbLike: {
    query(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: bigint };
    };
  },
  frag: SqlFragment,
): { changes: number; lastInsertRowid: bigint } {
  return dbLike.query(frag.text).run(...frag.params);
}

function runFragment(
  dbLike: {
    query(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: bigint };
    };
  },
  frag: SqlFragment,
): { changes: number; lastInsertRowid: bigint } {
  return run(dbLike, frag);
}

function runAll<T = Record<string, unknown>>(
  dbLike: {
    query(sql: string): {
      all(...params: unknown[]): unknown[];
    };
  },
  frag: SqlFragment,
): T[] {
  return all<T>(dbLike, frag);
}

function runGet<T = Record<string, unknown>>(
  dbLike: {
    query(sql: string): {
      get(...params: unknown[]): unknown;
    };
  },
  frag: SqlFragment,
): T | null {
  return get<T>(dbLike, frag);
}
