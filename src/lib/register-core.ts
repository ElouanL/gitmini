// Base records: actions, context menu entries, managers. Imported before `register-domains.ts`
// (src/main.ts) so that a domain can replace an action or entry in the base (same identifier).
import { registerBuiltinActions } from './actions/builtin';
import { opActions } from './actions/op-actions';
import { registerActions } from './actions/registry';
import { registerBuiltinMenus } from './menus/builtin';

let done = false;

export function registerCore(): void {
  if (done) return;
  done = true;
  registerBuiltinActions();
  registerActions(opActions);
  registerBuiltinMenus();
}

registerCore();
