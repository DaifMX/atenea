import { resolve } from "node:path";
import { dirname } from "node:path";
import { openStateDb, type StateDb } from "@atenea/state";

export interface ResolveAteneaHomeArgs {
  flag?: string | undefined;
  env?: string | undefined;
  configPath: string;
}

export function resolveAteneaHome(args: ResolveAteneaHomeArgs): string {
  if (args.flag) return resolve(args.flag);
  if (args.env && args.env.length > 0) return resolve(args.env);
  return resolve(dirname(args.configPath), ".atenea");
}

export function openState(ateneaHome: string): StateDb {
  return openStateDb({ ateneaHome });
}
