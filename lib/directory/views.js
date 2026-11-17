/**
 * What an agent sees of a directory contact. Pure. Ported from the crawler's
 * directory: the field names and
 * the rules are the same, so a saved agent gets the same answer from either.
 *
 * Never add a field that holds a number to the resolve view. Saved agents hide
 * the numbers from the model by name (`redact: ["extension", "direct",
 * "mobile"]`), so a new number field would reach the model.
 *
 * A contact is `{ id, kind, name, role, department, about, hours,
 * notesForAgent, discloseNumbers, extension, direct, mobile, email, userId }`.
 */

/** Only a team or service that has said so gives out its numbers. */
export function mayDisclose(kind, discloseNumbers) {
  return kind !== 'person' && discloseNumbers === true;
}

/** What a model may see: never a person's numbers, never an email. */
export function lookupView(c) {
  const view = {
    id: c.id,
    kind: c.kind,
    name: c.name,
    role: c.role,
    department: c.department,
    about: c.about,
    hours: c.hours,
    notes_for_agent: c.notesForAgent,
    can_transfer: Boolean(c.extension || c.direct || c.mobile),
    can_take_message: Boolean(c.userId && c.email),
  };
  if (mayDisclose(c.kind, c.discloseNumbers)) {
    view.extension = c.extension;
    view.direct = c.direct;
    view.mobile = c.mobile;
  }
  return view;
}

/** The payload of the transfer step. The numbers ride here, hidden from the model by `redact`. */
export function resolveView(c) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    role: c.role,
    department: c.department,
    about: c.about,
    hours: c.hours,
    notes_for_agent: c.notesForAgent,
    extension: c.extension,
    direct: c.direct,
    mobile: c.mobile,
    message_to: c.userId && c.email ? c.email : null,
  };
}

export const candidateView = (c) => ({ id: c.id, kind: c.kind, name: c.name, role: c.role, department: c.department });
