// Wire a "chip editor" behavior: a rendered pill list + input row + Add
// button. Enter or click Add appends a normalized value; the × on each pill
// removes it. Each mutation flushes via onChange(items) before rerender.
// Used for tools, locations, and any similar tag-style editor.
//
// Contract:
//   listEl, inputEl, addBtnEl : pre-rendered DOM refs
//   initial                    : seed array
//   render(items)              : returns list-body HTML (pills or empty state)
//   dismissSelector            : CSS selector for remove buttons inside render()
//   itemAttr                   : dataset key on the remove button, e.g. 'tool'
//   normalize(items)?          : hydrator applied after add/remove (default identity)
//   isDuplicate(items, val)?   : pre-add guard (default case-insensitive equality)
//   onChange(items)            : awaited; if it throws, the mutation is dropped
//                                and rerender is skipped (caller handles the
//                                error surface itself).

const defaultIsDuplicate = (items, val) =>
  items.some((x) => String(x).toLowerCase() === val.toLowerCase());

export const wireChipEditor = ({
  listEl, inputEl, addBtnEl,
  initial = [],
  render,
  dismissSelector,
  itemAttr,
  normalize = (x) => x,
  isDuplicate = defaultIsDuplicate,
  onChange,
}) => {
  let items = normalize([...initial]);

  const rerender = () => {
    listEl.innerHTML = render(items);
    listEl.querySelectorAll(dismissSelector).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset[itemAttr];
        const next = normalize(items.filter((x) => x !== name));
        try { await onChange(next); }
        catch { return; }
        items = next;
        rerender();
      });
    });
  };

  const add = async () => {
    const val = (inputEl.value || '').trim();
    if (!val) return;
    if (isDuplicate(items, val)) { inputEl.value = ''; inputEl.focus(); return; }
    const next = normalize([...items, val]);
    inputEl.value = '';
    try { await onChange(next); }
    catch { return; }
    items = next;
    rerender();
    inputEl.focus();
  };

  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); add(); }
  });
  addBtnEl.addEventListener('click', add);
  rerender();
};
