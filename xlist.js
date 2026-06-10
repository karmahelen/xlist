// -- State --
let lists = [];
let activeListId = null;
let items = [];

// savedCollapsed = the persisted preference (xlist.json). viewCollapsed = the
// current view's drawer state, derived from the pref at each view-entry but forced
// open on an empty list. They diverge only on empty lists; toggling updates both.
let savedCollapsed = false;
let viewCollapsed = false;

// "stay" (checked items remain in place) or "sink" (checked items drop below the
// unchecked ones). Display-only — never mutates item position. Loaded from xlist.json.
let checkBehavior = 'stay';

// -- Helpers --
// List names and item text are freeform user input injected into innerHTML, so
// escape them (unlike xstocks' tickers, which are constrained identifiers).
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setStatus(msg) {
    document.getElementById('statusText').textContent = msg;
}

function updateCount() {
    const done = items.filter(i => i.checked).length;
    document.getElementById('statusCount').textContent =
        items.length ? `${done} / ${items.length} checked` : '';
}

function checkIcon(checked) {
    return checked
        ? `<svg class="ico ico-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : `<svg class="ico ico-x" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`;
}

// Up-chevron; CSS rotates it 180deg when the controls drawer is collapsed.
function chevronIcon() {
    return `<svg class="ico ico-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// -- Init --
async function init() {
    lists = await app.call('get_lists');
    const cfg = await app.call('get_config');
    savedCollapsed = !!cfg.controls_collapsed;
    checkBehavior = cfg.check_behavior || 'stay';
    if (lists.length === 0) {
        showAddList();
        return;
    }
    activeListId = lists[0].id;
    await loadItems();
}

// -- List selector (now lives on the control row, rebuilt by renderList) --
function listSelectHtml() {
    const options = lists.map(l =>
        `<option value="${l.id}" ${l.id === activeListId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
    ).join('');
    let sentinels = '<option value="__add__">+ Add List</option>';
    if (lists.length > 1) sentinels += '<option value="__reorder__">Reorder Lists</option>';
    return `<select id="listSelect" class="list-select" onchange="handleListChange(this.value)">${options}${sentinels}</select>`;
}

function handleListChange(value) {
    if (value === '__add__') { showAddList(); return; }
    if (value === '__reorder__') { showReorderLists(); return; }
    activeListId = parseInt(value);
    loadItems();
}

// -- Add a New List --
function showAddList() {
    const el = document.getElementById('content');
    el.innerHTML = `
        <div class="setup">
            <h2>Add a New List</h2>
            <input type="text" id="listNameInput" placeholder="List name (e.g. Camping Gear)"
                   onkeydown="if(event.key==='Enter') document.getElementById('listItemsInput').focus()">
            <textarea id="listItemsInput" class="setup-textarea"
                      placeholder="One item per line:&#10;Tent&#10;Sleeping Bag&#10;Backpack"></textarea>
            <div class="form-actions">
                <button class="btn primary" onclick="submitAddList()">Create List</button>
                ${lists.length > 0 ? '<button class="btn" onclick="returnToActiveList()">Cancel</button>' : ''}
            </div>
        </div>
    `;
    document.getElementById('listNameInput').focus();
}

async function submitAddList() {
    const name = document.getElementById('listNameInput').value.trim();
    const itemsText = document.getElementById('listItemsInput').value;
    if (!name) { setStatus('List name is required'); return; }

    setStatus('Creating list...');
    try {
        const data = await app.call('add_list', { name, items: itemsText });
        if (data.status === 'name_exists') {
            setStatus('A list with that name already exists');
            return;
        }
        lists = data.lists;
        activeListId = data.list.id;
        items = data.items;
        viewCollapsed = items.length > 0 ? savedCollapsed : false;
        renderList();
        setStatus('Ready');
        updateCount();
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// Shared exit path from the Add / Edit / Reorder / Settings views back to the active
// list. Clears the reorder guard, then reloads the active list (rebuilding dropdown +
// controls + items). Falls back to the Add form when there are no lists yet.
function returnToActiveList() {
    inReorderView = false;
    if (lists.length === 0 || activeListId == null) {
        showAddList();
        return;
    }
    loadItems();
}

// -- Settings (cogwheel) --
function showSettings() {
    const el = document.getElementById('content');
    el.innerHTML = `
        <div class="setup">
            <h2>Settings</h2>
            <div class="settings-group">
                <div class="lbl">When a list item is checked</div>
                <label class="opt"><input type="radio" name="checkBehavior" value="stay" ${checkBehavior === 'stay' ? 'checked' : ''}> Checked items remain at current position</label>
                <label class="opt"><input type="radio" name="checkBehavior" value="sink" ${checkBehavior === 'sink' ? 'checked' : ''}> Checked items go to the bottom of the list</label>
            </div>
            <div class="form-actions">
                <button class="btn primary" onclick="submitSettings()">Save</button>
                <button class="btn" onclick="returnToActiveList()">Cancel</button>
            </div>
        </div>
    `;
}

async function submitSettings() {
    const sel = document.querySelector('input[name="checkBehavior"]:checked');
    const value = sel ? sel.value : checkBehavior;
    setStatus('Saving settings...');
    try {
        const data = await app.call('set_settings', { check_behavior: value });
        checkBehavior = data.check_behavior;
        // Re-render the list under the new sort, then report saved.
        if (lists.length === 0 || activeListId == null) {
            showAddList();
        } else {
            await loadItems();
        }
        setStatus('Settings saved');
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Edit a List (rename + items + delete) --
function showEditList() {
    const list = lists.find(l => l.id === activeListId);
    if (!list) return;
    const el = document.getElementById('content');
    // Prefill in position order (the order shown) — not sorted. Editing the
    // textarea also reorders, since line order drives item position on submit.
    const itemsText = items.map(i => i.text).join('\n');
    el.innerHTML = `
        <div class="setup">
            <h2>Edit ${escapeHtml(list.name)}</h2>
            <input type="text" id="listNameInput" value="${escapeHtml(list.name)}" placeholder="List name"
                   onkeydown="if(event.key==='Enter') document.getElementById('listItemsInput').focus()">
            <textarea id="listItemsInput" class="setup-textarea"
                      placeholder="One item per line">${escapeHtml(itemsText)}</textarea>
            <div class="form-actions">
                <button class="btn primary" onclick="submitEditList()">Update</button>
                <button class="btn" onclick="returnToActiveList()">Cancel</button>
                <button class="btn danger" onclick="deleteList()">Delete</button>
            </div>
        </div>
    `;
    document.getElementById('listNameInput').focus();
}

async function submitEditList() {
    const name = document.getElementById('listNameInput').value.trim();
    const itemsText = document.getElementById('listItemsInput').value;
    if (!name) { setStatus('List name is required'); return; }

    setStatus('Updating list...');
    try {
        const data = await app.call('update_list', { list_id: activeListId, name, items: itemsText });
        if (data.status === 'name_exists') {
            setStatus('A list with that name already exists');
            return;
        }
        lists = data.lists;
        activeListId = data.list.id;
        items = data.items;
        viewCollapsed = items.length > 0 ? savedCollapsed : false;
        renderList();
        setStatus('Ready');
        updateCount();
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

async function deleteList() {
    const list = lists.find(l => l.id === activeListId);
    if (!list) return;
    if (!confirm(`Delete the list "${list.name}" and all its items?`)) return;

    setStatus('Deleting list...');
    try {
        const data = await app.call('delete_list', { list_id: activeListId });
        lists = data.lists;
        if (lists.length > 0) {
            activeListId = lists[0].id;
            await loadItems();
        } else {
            activeListId = null;
            items = [];
            showAddList();
            setStatus('Ready');
            document.getElementById('statusCount').textContent = '';
        }
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

// -- Reorder Lists --
// reorderState is a working copy mutated by the user; nothing hits the DB until Update.
// inReorderView guards against a deferred blur-render firing after the user has
// already navigated away (Update/Cancel) — see reorderCommitInput.
let reorderState = [];
let inReorderView = false;

function showReorderLists() {
    inReorderView = true;
    reorderState = lists.map(l => ({ id: l.id, name: l.name }));
    renderReorderView();
}

function renderReorderView() {
    if (!inReorderView) return;
    const el = document.getElementById('content');
    const rows = reorderState.map((l, idx) => `
        <div class="reorder-row">
            <button class="btn reorder-btn" onclick="reorderMoveUp(${l.id})" title="Move up">↑</button>
            <button class="btn reorder-btn" onclick="reorderMoveDown(${l.id})" title="Move down">↓</button>
            <input type="text" class="reorder-pos" value="${idx + 1}" data-id="${l.id}"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();reorderCommitInput(this,false);}"
                   onblur="reorderCommitInput(this,true)">
            <span class="reorder-name">${escapeHtml(l.name)}</span>
        </div>
    `).join('');
    el.innerHTML = `
        <div class="setup">
            <h2>Reorder Lists</h2>
            <div class="reorder-list">${rows}</div>
            <div class="form-actions">
                <button class="btn primary" onclick="submitReorderLists()">Update</button>
                <button class="btn" onclick="returnToActiveList()">Cancel</button>
            </div>
        </div>
    `;
}

function reorderMoveUp(id) {
    const idx = reorderState.findIndex(l => l.id === id);
    if (idx === -1) return;
    if (idx === 0) {
        const [item] = reorderState.splice(0, 1);
        reorderState.push(item);              // wrap: top -> bottom
    } else {
        [reorderState[idx - 1], reorderState[idx]] = [reorderState[idx], reorderState[idx - 1]];
    }
    renderReorderView();
}

function reorderMoveDown(id) {
    const idx = reorderState.findIndex(l => l.id === id);
    if (idx === -1) return;
    const n = reorderState.length;
    if (idx === n - 1) {
        const [item] = reorderState.splice(n - 1, 1);
        reorderState.unshift(item);           // wrap: bottom -> top
    } else {
        [reorderState[idx], reorderState[idx + 1]] = [reorderState[idx + 1], reorderState[idx]];
    }
    renderReorderView();
}

function reorderCommitInput(inputEl, fromBlur) {
    const id = parseInt(inputEl.dataset.id, 10);
    const oldIdx = reorderState.findIndex(l => l.id === id);
    if (oldIdx === -1) return;
    const raw = inputEl.value.trim();
    const n = reorderState.length;

    // Valid only if a clean integer in range 1..n and actually different.
    const valid = /^\d+$/.test(raw) && +raw >= 1 && +raw <= n && +raw !== oldIdx + 1;
    if (valid) {
        const [item] = reorderState.splice(oldIdx, 1);
        reorderState.splice(+raw - 1, 0, item);
    }

    // From blur: defer so a pending click (Move buttons, Update, Cancel) fires first
    // on the still-existing DOM. From Enter: render immediately.
    if (fromBlur) {
        setTimeout(renderReorderView, 0);
    } else {
        renderReorderView();
    }
}

async function submitReorderLists() {
    inReorderView = false;
    try {
        const data = await app.call('reorder_lists', { ordered_ids: reorderState.map(l => l.id) });
        lists = data.lists;
        await loadItems();          // rebuilds the reordered dropdown + items
        setStatus('Lists reordered');
    } catch (e) {
        inReorderView = true;       // stay in the view so the user can retry
        setStatus('Error: ' + e.message);
    }
}

// -- Load + render the active list --
async function loadItems() {
    setStatus('Loading...');
    items = await app.call('get_items', { list_id: activeListId });
    // View-entry: derive the drawer state from the saved pref, but force it open on
    // an empty list (you'd otherwise have no visible way to add the first item).
    viewCollapsed = items.length > 0 ? savedCollapsed : false;
    renderList();
    setStatus('Ready');
    updateCount();
}

// Display order is derived, never stored: "stay" shows items in authored position
// order; "sink" partitions unchecked-then-checked, each group keeping position order.
function displayItems() {
    if (checkBehavior !== 'sink') return items;
    return items.filter(i => !i.checked).concat(items.filter(i => i.checked));
}

function itemRowsHtml() {
    return displayItems().map(it => `
        <div class="item-row ${it.checked ? 'checked' : ''}" data-id="${it.id}" onclick="toggleItem(${it.id})">
            <span class="item-check">${checkIcon(it.checked)}</span>
            <span class="item-text">${escapeHtml(it.text)}</span>
        </div>`).join('');
}

function renderList() {
    const el = document.getElementById('content');
    const hasItems = items.length > 0;
    const collapsedClass = viewCollapsed ? ' collapsed' : '';

    // Control row (always visible): list selector + the controls toggle.
    // Navigation stays put; management (the drawer below) folds away.
    const controlRow = `
        <div class="control-row">
            ${listSelectHtml()}
            ${hasItems ? `<button class="ctrl-toggle" aria-label="Show or hide controls" onclick="toggleControls()">${chevronIcon()}</button>` : ''}
        </div>`;

    // Collapsible drawer: the management controls.
    const drawer = `
        <div class="drawer"><div class="drawer-inner">
            <div class="control-actions">
                <input type="text" id="addItemInput" class="add-item-input" placeholder="Add item..."
                       onkeydown="if(event.key==='Enter') addItem()">
                <button class="btn" onclick="addItem()">Add</button>
                <button class="btn" onclick="showEditList()">Edit</button>
                ${hasItems ? '<button class="btn" onclick="clearList()">Clear</button>' : ''}
            </div>
        </div></div>`;

    const body = hasItems
        ? `<div class="item-list">${itemRowsHtml()}</div>`
        : `<div class="empty-note">This list is empty.<br>Add an item above to get started.</div>`;

    el.innerHTML =
        `<div class="list-controls${collapsedClass}" id="listControls">${controlRow}${drawer}</div>${body}`;
}

// Toggle the controls drawer. Flips a class on the existing wrapper (so CSS animates
// the collapse) rather than re-rendering, and persists the preference fire-and-forget.
function toggleControls() {
    viewCollapsed = !viewCollapsed;
    savedCollapsed = viewCollapsed;
    const wrap = document.getElementById('listControls');
    if (wrap) wrap.classList.toggle('collapsed', viewCollapsed);
    if (!viewCollapsed) {
        const inp = document.getElementById('addItemInput');
        if (inp) inp.focus();
    }
    app.call('set_controls_collapsed', { collapsed: viewCollapsed })
        .catch(() => setStatus('Could not save view state'));
}

// -- Item interactions --

// Optimistic: update the DOM immediately, persist async, revert on failure.
// "stay": targeted icon flip, no movement. "sink": re-sort the item list with a
// FLIP glide so the toggled item animates to its new position.
async function toggleItem(id) {
    const it = items.find(i => i.id === id);
    if (!it) return;

    const newChecked = it.checked ? 0 : 1;
    applyToggle(it, newChecked);
    updateCount();

    try {
        await app.call('set_checked', { item_id: id, checked: newChecked });
    } catch (e) {
        applyToggle(it, newChecked ? 0 : 1);   // revert
        updateCount();
        setStatus('Error saving: ' + e.message);
    }
}

function applyToggle(it, checked) {
    it.checked = checked;
    if (checkBehavior === 'sink') {
        flipReorder();
    } else {
        applyRowState(it.id, checked);
    }
}

function applyRowState(id, checked) {
    const row = document.querySelector(`.item-row[data-id="${id}"]`);
    if (!row) return;
    row.classList.toggle('checked', !!checked);
    const cell = row.querySelector('.item-check');
    if (cell) cell.innerHTML = checkIcon(checked);
}

// FLIP: record row positions (First), re-render the item list in the new sorted order
// (Last), then translate each row from its old spot and transition to zero (Invert/Play).
// Only the .item-list is rebuilt, so the add-item input's text and focus are preserved.
function flipReorder() {
    const listEl = document.querySelector('.item-list');
    if (!listEl) return;

    const first = {};
    listEl.querySelectorAll('.item-row').forEach(r => {
        first[r.dataset.id] = r.getBoundingClientRect().top;
    });

    listEl.innerHTML = itemRowsHtml();

    listEl.querySelectorAll('.item-row').forEach(r => {
        const prevTop = first[r.dataset.id];
        if (prevTop == null) return;
        const delta = prevTop - r.getBoundingClientRect().top;
        if (!delta) return;
        r.style.transition = 'transform 0s';
        r.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
            r.style.transition = 'transform 0.28s cubic-bezier(.2,.7,.3,1)';
            r.style.transform = '';
        });
        r.addEventListener('transitionend', function te() {
            r.style.transition = '';   // restore the CSS hover transition afterward
            r.removeEventListener('transitionend', te);
        });
    });
}

// add/clear re-render the list, which reads the unchanged viewCollapsed — so the
// drawer keeps whatever state it's in (these are only reachable while it's open).
async function addItem() {
    const input = document.getElementById('addItemInput');
    const text = input.value.trim();
    if (!text) return;

    setStatus('Adding item...');
    try {
        const data = await app.call('add_item', { list_id: activeListId, text });
        items = data.items;
        renderList();
        document.getElementById('addItemInput').focus();
        setStatus('Ready');
        updateCount();
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

async function clearList() {
    if (!confirm('Clear all checkmarks on this list?')) return;

    setStatus('Clearing...');
    try {
        const data = await app.call('clear_list', { list_id: activeListId });
        items = data.items;
        renderList();
        setStatus('Ready');
        updateCount();
    } catch (e) {
        setStatus('Error: ' + e.message);
    }
}

document.addEventListener('DOMContentLoaded', init);
