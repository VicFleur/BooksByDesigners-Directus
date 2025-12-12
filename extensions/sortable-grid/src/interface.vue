<template>
	<div class="sg">
		<div class="sg__toolbar">
			<div class="sg__toolbar-left">
				<div class="sg__label">Related</div>
				<div class="sg__count" v-if="orderedIds.length">{{ orderedIds.length }}</div>
			</div>

			<div class="sg__toolbar-right">
				<v-button
					v-if="enableSelect"
					small
					secondary
					:disabled="disabled || !relatedCollection"
					@click="openSelectDrawer"
				>
					Add Existing
				</v-button>

				<v-button
					v-if="enableCreate"
					small
					:disabled="disabled || !relatedCollection"
					@click="openCreateDrawer"
				>
					Create New
				</v-button>
			</div>
		</div>

		<div v-if="relationError" class="sg__notice">
			Unable to resolve relation metadata for this O2M field. The grid can still render existing values, but “Add
			Existing” / “Create New” may not work.
		</div>

		<div v-else-if="relationLoading" class="sg__notice">Loading relation…</div>

		<div v-else-if="!relatedCollection" class="sg__notice">
			No related collection detected for this O2M field.
		</div>

		<div v-if="!sortField" class="sg__notice">
			This relationship has no manual sort field configured. Drag reordering might not persist server-side until a sort
			field is set in the relationship settings.
		</div>

		<div
			class="sg__grid"
			:style="gridStyle"
			@dragover.prevent="onGridDragOver"
			@drop.prevent="onGridDrop"
		>
			<template v-for="id in visibleIds" :key="idKey(id)">
				<div
					class="sg__card"
					:class="{
						'sg__card--dragging': draggingKey === idKey(id),
						'sg__card--drag-over': dragOverKey === idKey(id)
					}"
					:draggable="!disabled"
					@dragstart="onDragStart(id, $event)"
					@dragend="onDragEnd"
					@dragover.prevent="onCardDragOver(id)"
					@drop.prevent="onCardDrop(id)"
				>
					<div class="sg__cover">
						<img v-if="coverUrl(id)" class="sg__cover-img" :src="coverUrl(id)" alt="" />
						<div v-else class="sg__cover-placeholder">
							<v-icon name="image" />
						</div>

						<div class="sg__card-actions">
							<v-button
								icon
								small
								secondary
								class="sg__icon-btn"
								:disabled="disabled"
								@click.stop="unlink(id)"
							>
								<v-icon name="close" />
							</v-button>

							<div class="sg__drag-handle" title="Drag to reorder">
								<v-icon name="drag_indicator" />
							</div>
						</div>
					</div>

					<div class="sg__card-body">
						<div class="sg__title">
							{{ titleText(id) }}
						</div>
						<div class="sg__subtitle">
							{{ subtitleText(id) }}
						</div>
					</div>
				</div>
			</template>

			<div v-if="orderedIds.length === 0" class="sg__empty">
				<div class="sg__empty-title">No related items</div>
				<div class="sg__empty-actions">
					<v-button
						v-if="enableSelect"
						small
						secondary
						:disabled="disabled || !relatedCollection"
						@click="openSelectDrawer"
					>
						Add Existing
					</v-button>
					<v-button
						v-if="enableCreate"
						small
						:disabled="disabled || !relatedCollection"
						@click="openCreateDrawer"
					>
						Create New
					</v-button>
				</div>
			</div>

			<div ref="sentinelEl" class="sg__sentinel" />
		</div>

		<!-- Select Existing -->
		<v-drawer
			title="Add Existing"
			:model-value="selectDrawerOpen"
			@update:model-value="onSelectDrawerModelValue"
			@cancel="onSelectDrawerCancel"
		>
			<div ref="selectGridEl" class="sg__drawer-grid">
				<div
					v-for="item in selectItems"
					:key="idKey(item[relatedPrimaryKeyField])"
					class="sg__card sg__card--select"
					:class="{
						'sg__card--selected': selectedCandidateByKey.has(idKey(item[relatedPrimaryKeyField])),
						'sg__card--disabled': orderedKeySet.has(idKey(item[relatedPrimaryKeyField]))
					}"
					@click="toggleCandidate(item[relatedPrimaryKeyField])"
				>
					<div class="sg__cover">
						<img v-if="coverUrlFromItem(item)" class="sg__cover-img" :src="coverUrlFromItem(item)" alt="" />
						<div v-else class="sg__cover-placeholder">
							<v-icon name="image" />
						</div>
					</div>
					<div class="sg__card-body">
						<div class="sg__title">{{ getByPath(item, cardTitle) ?? '—' }}</div>
						<div class="sg__subtitle">{{ getByPath(item, cardSubtitle) ?? '' }}</div>
					</div>
				</div>

				<div v-if="selectError" class="sg__drawer-state">Failed to load items.</div>
				<div v-else-if="selectLoading && selectItems.length === 0" class="sg__drawer-state">Loading…</div>
				<div v-else-if="!selectLoading && selectItems.length === 0" class="sg__drawer-state">No items found.</div>

				<div ref="selectSentinelEl" class="sg__sentinel" />
			</div>

			<template #actions>
				<div class="sg__drawer-actions">
					<div class="sg__drawer-search">
						<v-input v-model="selectSearch" placeholder="Search…" @update:modelValue="onSelectSearchChange" />
					</div>
					<v-button :disabled="selectedCandidateByKey.size === 0" @click="addSelectedCandidates">
						Add {{ selectedCandidateByKey.size }}
					</v-button>
				</div>
			</template>
		</v-drawer>

		<!-- Create New -->
		<v-drawer
			title="Create New"
			:model-value="createDrawerOpen"
			@update:model-value="onCreateDrawerModelValue"
			@cancel="onCreateDrawerCancel"
		>
			<div v-if="!relatedCollection" class="sg__drawer-state">No related collection available.</div>
			<div v-else class="sg__drawer-form">
				<v-form :collection="relatedCollection" v-model="createForm" :initial-values="createInitialValues" />
			</div>

			<template #actions>
				<v-button :disabled="createLoading || !relatedCollection" @click="createItem">
					{{ createLoading ? 'Creating…' : 'Create' }}
				</v-button>
			</template>
		</v-drawer>
	</div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, toRefs, watch } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';

const props = defineProps({
	value: { type: Array, default: () => [] },
	primaryKey: { type: String, default: 'id' },
	collection: { type: String, required: true },
	field: { type: String, required: true },
	width: { type: String, default: 'full' },
	disabled: { type: Boolean, default: false },
	layout: { type: String, default: 'grid' },
	tableSpacing: { type: String, default: 'cozy' },
	version: { type: String, default: '1.0.0' },
	fields: { type: Array, default: () => ['id'] },
	template: { type: String, default: null },
	enableCreate: { type: Boolean, default: true },
	enableSelect: { type: Boolean, default: true },
	filter: { type: Object, default: () => null },
	enableSearchFilter: { type: Boolean, default: false },
	enableLink: { type: Boolean, default: true },
	limit: { type: Number, default: 1000 },
	sort: { type: String, default: 'id' },
	sortDirection: { type: String, default: 'asc' }
});

const emit = defineEmits(['input']);

const api = useApi();

const { collection, field, primaryKey: parentKey, disabled, enableCreate, enableSelect } = toRefs(props);
const { useFieldsStore } = useStores();
const fieldsStore = useFieldsStore();

// Primary key field name for the related (many-side) collection.
// In Directus, the `primaryKey` prop can be the *parent item's key value* (and is '+' for unsaved items),
// so we must NOT use it as a field selector.
const relatedPrimaryKeyField = ref('id');

const fieldMeta = computed(() => fieldsStore.getField(collection.value, field.value)?.meta || {});
const options = computed(() => fieldMeta.value?.options ?? {});

function normalizeFieldPath(raw) {
	if (!raw) return null;
	if (typeof raw !== 'string') return null;
	let s = raw.trim();
	if (!s) return null;

	// Allow templates like "{{ designer.name }}"
	const mustache = s.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
	if (mustache) s = mustache[1].trim();

	// Directus UI often displays nested fields as "designer > name"
	s = s.replace(/\s*>\s*/g, '.');

	// Normalize dot spacing and strip remaining whitespace
	s = s.replace(/\s*\.\s*/g, '.').replace(/\s+/g, '');

	// Trim stray dots
	s = s.replace(/^\.+/, '').replace(/\.+$/, '');

	return s || null;
}

// Interface options (your requested knobs)
const cardCover = computed(() => normalizeFieldPath(options.value.card_cover));
const cardTitle = computed(() => normalizeFieldPath(options.value.card_title));
const cardSubtitle = computed(() => normalizeFieldPath(options.value.card_subtitle));
const columns = computed(() => Number(options.value.columns || 6));
const pageSize = computed(() => Number(options.value.limit || 1000));

function idKey(id) {
	return String(id);
}

function getByPath(obj, path) {
	if (!obj || !path) return null;
	if (typeof path !== 'string') return null;
	const parts = path.split('.').filter(Boolean);
	let current = obj;
	for (const part of parts) {
		if (current == null) return null;
		current = current[part];
	}
	return current ?? null;
}

function extractId(entry) {
	if (entry == null) return null;
	if (typeof entry === 'object') return entry[relatedPrimaryKeyField.value] ?? entry.id ?? null;
	return entry;
}

const localValue = ref(Array.isArray(props.value) ? props.value : []);
watch(
	() => props.value,
	(v) => {
		localValue.value = Array.isArray(v) ? v : [];
	},
	{ deep: true }
);

const orderedIds = computed(() => {
	const v = localValue.value;
	if (!Array.isArray(v)) return [];
	const seen = new Set();
	const ids = [];
	for (const entry of v) {
		const id = extractId(entry);
		if (id == null) continue;
		const key = idKey(id);
		if (seen.has(key)) continue;
		seen.add(key);
		ids.push(id);
	}
	return ids;
});

const orderedKeySet = computed(() => new Set(orderedIds.value.map(idKey)));

const gridStyle = computed(() => ({
	gridTemplateColumns: `repeat(${Math.max(1, columns.value || 6)}, minmax(0, 1fr))`
}));

// --- Resolve relation metadata (related collection, sort field, etc.)
const relationInfo = ref(null);
const relationLoading = ref(false);
const relationError = ref(null);

const relatedCollection = computed(() => relationInfo.value?.collection ?? null);
const m2oField = computed(() => relationInfo.value?.field ?? null);
const sortField = computed(() => relationInfo.value?.meta?.sort_field ?? null);

async function fetchRelatedPrimaryKeyField() {
	if (!relatedCollection.value) {
		relatedPrimaryKeyField.value = 'id';
		return;
	}

	try {
		const res = await api.get(`/fields/${relatedCollection.value}`, { params: { limit: -1 } });
		const fields = res?.data?.data ?? [];
		const pk = fields.find((f) => f?.schema?.is_primary_key)?.field;
		relatedPrimaryKeyField.value = pk || 'id';
	} catch {
		relatedPrimaryKeyField.value = 'id';
	}
}

watch(relatedCollection, () => void fetchRelatedPrimaryKeyField(), { immediate: true });

async function fetchRelationInfo() {
	relationError.value = null;
	relationLoading.value = true;
	relationInfo.value = null;
	try {
		const res = await api.get('/relations', {
			params: {
				filter: {
					related_collection: { _eq: collection.value },
					meta: { one_field: { _eq: field.value } }
				},
				limit: 1
			}
		});
		relationInfo.value = res?.data?.data?.[0] ?? null;
	} catch (err) {
		relationError.value = err;
		relationInfo.value = null;
	} finally {
		relationLoading.value = false;
	}
}

watch([collection, field], () => void fetchRelationInfo(), { immediate: true });

// --- Fetch and cache related items by ID (lazy / infinite)
const itemsByKey = ref(new Map());
const loadingKeys = ref(new Set());

watch(
	() => localValue.value,
	(v) => {
		// If Directus gives us objects, seed cache so we can render instantly.
		if (!Array.isArray(v)) return;
		for (const entry of v) {
			if (entry && typeof entry === 'object') {
				const id = extractId(entry);
				if (id == null) continue;
				itemsByKey.value.set(idKey(id), entry);
			}
		}
	},
	{ deep: true, immediate: true }
);

const requestedFields = computed(() => {
	const set = new Set([relatedPrimaryKeyField.value]);
	const cover = cardCover.value;
	const title = cardTitle.value;
	const subtitle = cardSubtitle.value;
	if (cover) set.add(cover);
	if (title) set.add(title);
	if (subtitle) set.add(subtitle);
	return Array.from(set);
});

const visibleCount = ref(0);
watch(
	() => orderedIds.value.length,
	(total) => {
		if (visibleCount.value === 0) {
			visibleCount.value = Math.min(total, Math.max(1, pageSize.value || 1000));
			return;
		}
		visibleCount.value = Math.min(visibleCount.value, total);
	},
	{ immediate: true }
);

const visibleIds = computed(() => orderedIds.value.slice(0, visibleCount.value));

async function fetchItemsByIds(ids) {
	if (!relatedCollection.value) return;
	if (!ids.length) return;

	const pk = relatedPrimaryKeyField.value;
	const chunkSize = 100;
	const fields = requestedFields.value;

	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		try {
			const res = await api.get(`/items/${relatedCollection.value}`, {
				params: {
					fields,
					filter: { [pk]: { _in: chunk } },
					limit: -1
				}
			});
			const rows = res?.data?.data ?? [];
			for (const row of rows) {
				const id = row?.[pk] ?? row?.id;
				if (id == null) continue;
				itemsByKey.value.set(idKey(id), row);
			}
		} catch {
			// swallow; UI still works with whatever we already have
		} finally {
			for (const id of chunk) loadingKeys.value.delete(idKey(id));
		}
	}
}

async function ensureVisibleFetched() {
	if (!relatedCollection.value) return;
	const missing = [];
	for (const id of visibleIds.value) {
		const key = idKey(id);
		if (itemsByKey.value.has(key)) continue;
		if (loadingKeys.value.has(key)) continue;
		loadingKeys.value.add(key);
		missing.push(id);
	}
	if (missing.length) await fetchItemsByIds(missing);
}

watch([visibleIds, requestedFields, relatedCollection], () => void ensureVisibleFetched(), { immediate: true });

// IntersectionObserver sentinel for infinite scroll
const sentinelEl = ref(null);
let observer = null;

function loadMore() {
	const total = orderedIds.value.length;
	if (visibleCount.value >= total) return;
	visibleCount.value = Math.min(total, visibleCount.value + Math.max(1, pageSize.value || 1000));
}

onMounted(() => {
	observer = new IntersectionObserver(
		(entries) => {
			if (entries.some((e) => e.isIntersecting)) loadMore();
		},
		{ root: null, rootMargin: '300px', threshold: 0.01 }
	);
	if (sentinelEl.value) observer.observe(sentinelEl.value);
});

watch(
	sentinelEl,
	(el, prev) => {
		if (!observer) return;
		if (prev) observer.unobserve(prev);
		if (el) observer.observe(el);
	},
	{ flush: 'post' }
);

onBeforeUnmount(() => {
	if (observer) observer.disconnect();
});

// --- Rendering helpers
function itemFor(id) {
	return itemsByKey.value.get(idKey(id)) ?? null;
}

function titleText(id) {
	const item = itemFor(id);
	return (getByPath(item, cardTitle.value) ?? '—') + '';
}

function subtitleText(id) {
	const item = itemFor(id);
	const v = getByPath(item, cardSubtitle.value);
	return v == null ? '' : String(v);
}

function coverIdFromValue(v) {
	if (v == null) return null;
	if (typeof v === 'string' || typeof v === 'number') return v;
	if (typeof v === 'object') return v.id ?? v[relatedPrimaryKeyField.value] ?? null;
	return null;
}

function assetUrlFromFileId(fileId) {
	if (!fileId) return null;
	return `/assets/${encodeURIComponent(String(fileId))}?fit=cover&width=600&height=800&quality=80`;
}

function coverUrl(id) {
	const item = itemFor(id);
	if (!item || !cardCover.value) return null;
	const v = getByPath(item, cardCover.value);
	if (v && typeof v === 'object' && typeof v.$thumbnail === 'string') return v.$thumbnail;
	const fileId = coverIdFromValue(v);
	return assetUrlFromFileId(fileId);
}

function coverUrlFromItem(item) {
	if (!item || !cardCover.value) return null;
	const v = getByPath(item, cardCover.value);
	if (v && typeof v === 'object' && typeof v.$thumbnail === 'string') return v.$thumbnail;
	const fileId = coverIdFromValue(v);
	return assetUrlFromFileId(fileId);
}

// --- Mutations (emit to Directus so persistence happens on parent save)
const emitsObjects = computed(() => {
	const v = localValue.value;
	if (!Array.isArray(v) || v.length === 0) return false;
	return typeof v[0] === 'object';
});

function buildValueFromIds(ids) {
	if (!emitsObjects.value) return ids;
	const byKey = new Map();
	for (const entry of localValue.value) {
		const id = extractId(entry);
		if (id == null) continue;
		byKey.set(idKey(id), entry);
	}
	return ids.map((id) => byKey.get(idKey(id)) ?? { [relatedPrimaryKeyField.value]: id });
}

function updateIds(nextIds) {
	const nextValue = buildValueFromIds(nextIds);
	localValue.value = nextValue;
	emit('input', nextValue);
}

function unlink(id) {
	const key = idKey(id);
	updateIds(orderedIds.value.filter((x) => idKey(x) !== key));
}

// --- Drag reorder (HTML5 DnD)
const draggingKey = ref(null);
const dragOverKey = ref(null);

function onDragStart(id, evt) {
	if (disabled.value) return;
	draggingKey.value = idKey(id);
	dragOverKey.value = null;
	if (evt?.dataTransfer) {
		evt.dataTransfer.effectAllowed = 'move';
		evt.dataTransfer.setData('text/plain', draggingKey.value);
	}
}

function onDragEnd() {
	draggingKey.value = null;
	dragOverKey.value = null;
}

function onCardDragOver(id) {
	if (!draggingKey.value) return;
	const over = idKey(id);
	if (over === draggingKey.value) return;
	dragOverKey.value = over;
}

function moveKeyBefore(fromKey, toKey) {
	const ids = [...orderedIds.value];
	const fromIndex = ids.findIndex((x) => idKey(x) === fromKey);
	let toIndex = ids.findIndex((x) => idKey(x) === toKey);
	if (fromIndex === -1 || toIndex === -1) return;
	const [moved] = ids.splice(fromIndex, 1);
	if (fromIndex < toIndex) toIndex -= 1;
	ids.splice(toIndex, 0, moved);
	updateIds(ids);
}

function onCardDrop(id) {
	if (!draggingKey.value) return;
	const toKey = idKey(id);
	if (toKey !== draggingKey.value) moveKeyBefore(draggingKey.value, toKey);
	onDragEnd();
}

function onGridDragOver() {
	// allow drop on grid (append)
}

function onGridDrop() {
	if (!draggingKey.value) return;
	const ids = [...orderedIds.value];
	const fromIndex = ids.findIndex((x) => idKey(x) === draggingKey.value);
	if (fromIndex === -1) return onDragEnd();
	const [moved] = ids.splice(fromIndex, 1);
	ids.push(moved);
	updateIds(ids);
	onDragEnd();
}

// --- Select Existing drawer
const selectDrawerOpen = ref(false);
const selectSearch = ref('');
const selectItems = ref([]);
const selectLoading = ref(false);
const selectError = ref(false);
const selectedCandidateByKey = ref(new Map());

const selectOffset = ref(0);
const selectHasMore = ref(true);

const selectGridEl = ref(null);
const selectSentinelEl = ref(null);
let selectObserver = null;

const selectLimit = computed(() => Math.max(1, Math.min(100, pageSize.value || 50)));

function resetSelectResults() {
	selectItems.value = [];
	selectOffset.value = 0;
	selectHasMore.value = true;
	selectError.value = false;
}

async function fetchSelectNext() {
	if (!relatedCollection.value) return;
	if (!selectHasMore.value) return;
	if (selectLoading.value) return;

	selectLoading.value = true;
	selectError.value = false;

	try {
		const limit = selectLimit.value;
		const offset = selectOffset.value;
		const pk = relatedPrimaryKeyField.value;

		const res = await api.get(`/items/${relatedCollection.value}`, {
			params: {
				fields: requestedFields.value,
				limit,
				offset,
				search: selectSearch.value || undefined,
				filter: props.filter || undefined
			}
		});

		const rows = res?.data?.data ?? [];

		// Append unique items by PK
		const existing = new Set(selectItems.value.map((it) => idKey(it?.[pk] ?? it?.id)));
		const next = [...selectItems.value];
		for (const row of rows) {
			const key = idKey(row?.[pk] ?? row?.id);
			if (existing.has(key)) continue;
			existing.add(key);
			next.push(row);
		}
		selectItems.value = next;
		selectOffset.value += rows.length;

		const total = res?.data?.meta?.filter_count ?? res?.data?.meta?.total_count ?? null;
		if (typeof total === 'number') selectHasMore.value = selectOffset.value < total;
		else selectHasMore.value = rows.length === limit;
	} catch {
		selectError.value = true;
		selectHasMore.value = false;
	} finally {
		selectLoading.value = false;
	}
}

function teardownSelectObserver() {
	if (selectObserver) selectObserver.disconnect();
	selectObserver = null;
}

function setupSelectObserver() {
	teardownSelectObserver();
	if (!selectDrawerOpen.value) return;
	if (!selectGridEl.value || !selectSentinelEl.value) return;

	selectObserver = new IntersectionObserver(
		(entries) => {
			if (entries.some((e) => e.isIntersecting)) void fetchSelectNext();
		},
		{ root: selectGridEl.value, rootMargin: '300px', threshold: 0.01 }
	);

	selectObserver.observe(selectSentinelEl.value);
}

watch([selectDrawerOpen, selectGridEl, selectSentinelEl], () => void setupSelectObserver(), { flush: 'post' });

let selectSearchDebounce = null;
onBeforeUnmount(() => {
	teardownSelectObserver();
	if (selectSearchDebounce) clearTimeout(selectSearchDebounce);
});

function onSelectSearchChange() {
	if (!selectDrawerOpen.value) return;
	if (selectSearchDebounce) clearTimeout(selectSearchDebounce);
	selectSearchDebounce = setTimeout(() => {
		resetSelectResults();
		void fetchSelectNext();
	}, 250);
}

function onSelectDrawerModelValue(val) {
	selectDrawerOpen.value = !!val;
	if (selectDrawerOpen.value) {
		selectedCandidateByKey.value = new Map();
		resetSelectResults();
		void fetchSelectNext();
	} else {
		teardownSelectObserver();
		selectedCandidateByKey.value = new Map();
	}
}

function onSelectDrawerCancel() {
	onSelectDrawerModelValue(false);
}

function openSelectDrawer() {
	onSelectDrawerModelValue(true);
}

function toggleCandidate(id) {
	const key = idKey(id);
	if (orderedKeySet.value.has(key)) return; // already linked
	const next = new Map(selectedCandidateByKey.value);
	if (next.has(key)) next.delete(key);
	else next.set(key, id);
	selectedCandidateByKey.value = next;
}

function addSelectedCandidates() {
	const current = orderedIds.value;
	const currentKeys = new Set(current.map(idKey));
	const toAdd = [];
	for (const [key, id] of selectedCandidateByKey.value.entries()) {
		if (currentKeys.has(key)) continue;
		toAdd.push(id);
	}
	updateIds([...current, ...toAdd]);
	onSelectDrawerModelValue(false);
}

// --- Create New drawer
const createDrawerOpen = ref(false);
const createForm = ref({});
const createLoading = ref(false);

const parentItemId = computed(() => {
	try {
		if (parentKey.value != null && parentKey.value !== '+' && parentKey.value !== 'id') return parentKey.value;

		const path = window.location.pathname || '';
		const parts = path.split('/').filter(Boolean);
		const contentIndex = parts.indexOf('content');
		if (contentIndex !== -1 && parts.length >= contentIndex + 3) return parts[contentIndex + 2];
		return null;
	} catch {
		return null;
	}
});

const createInitialValues = computed(() => {
	const init = {};
	if (m2oField.value && parentItemId.value && parentItemId.value !== '+') init[m2oField.value] = parentItemId.value;
	return init;
});

function openCreateDrawer() {
	onCreateDrawerModelValue(true);
	createForm.value = {};
}

function onCreateDrawerModelValue(val) {
	createDrawerOpen.value = !!val;
	if (createDrawerOpen.value) {
		createForm.value = {};
		return;
	}

	createForm.value = {};
	createLoading.value = false;
}

function onCreateDrawerCancel() {
	onCreateDrawerModelValue(false);
}

async function createItem() {
	if (!relatedCollection.value) return;
	createLoading.value = true;
	try {
		const res = await api.post(`/items/${relatedCollection.value}`, createForm.value, {
			params: { fields: [relatedPrimaryKeyField.value] }
		});
		const created = res?.data?.data ?? null;
		const createdId = created?.[relatedPrimaryKeyField.value] ?? created?.id ?? null;
		if (createdId != null) updateIds([...orderedIds.value, createdId]);
		onCreateDrawerModelValue(false);
	} catch {
		// noop (Directus will show toast for failed request in most cases)
	} finally {
		createLoading.value = false;
	}
}
</script>

<style scoped>
.sg {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.sg__toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.sg__toolbar-left {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.sg__label {
	font-weight: 600;
	color: var(--theme--foreground);
}

.sg__count {
	padding: 2px 8px;
	border-radius: 999px;
	background: var(--theme--background-subdued);
	color: var(--theme--foreground-subdued);
	font-size: 12px;
}

.sg__toolbar-right {
	display: flex;
	align-items: center;
	gap: 8px;
}

.sg__notice {
	padding: 10px 12px;
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
	color: var(--theme--foreground-subdued);
	font-size: 13px;
}

.sg__grid {
	display: grid;
	gap: 12px;
}

.sg__card {
	border: 1px solid var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background);
	user-select: none;
	cursor: grab;
}

.sg__card--select {
	cursor: pointer;
}

.sg__card--disabled {
	opacity: 0.5;
	pointer-events: none;
}

.sg__card--selected {
	outline: 2px solid var(--theme--primary);
}

.sg__card--dragging {
	opacity: 0.6;
}

.sg__card--drag-over {
	outline: 2px solid var(--theme--primary);
}

.sg__cover {
	position: relative;
	aspect-ratio: 1 / 1;
	background: var(--theme--background-subdued);
}

.sg__cover-img {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.sg__cover-placeholder {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	color: var(--theme--foreground-subdued);
}

.sg__card-actions {
	position: absolute;
	top: 8px;
	right: 8px;
	display: flex;
	align-items: center;
	gap: 6px;
}

.sg__drag-handle {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border-radius: 999px;
	background: color-mix(in srgb, var(--theme--background) 85%, transparent);
	border: 1px solid var(--theme--border-color);
	color: var(--theme--foreground-subdued);
	cursor: grab;
}

.sg__card-body {
	padding: 10px 12px 12px;
}

.sg__title {
	font-weight: 600;
	color: var(--theme--foreground);
	line-height: 1.2;
	display: -webkit-box;
	line-clamp: 2;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	min-height: 2.4em;
}

.sg__subtitle {
	margin-top: 4px;
	color: var(--theme--foreground-subdued);
	font-size: 12px;
	line-height: 1.3;
	display: -webkit-box;
	line-clamp: 2;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	min-height: 2.6em;
}

.sg__sentinel {
	height: 1px;
}

.sg__empty {
	grid-column: 1 / -1;
	padding: 28px 12px;
	text-align: center;
	border: 1px dashed var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	color: var(--theme--foreground-subdued);
}

.sg__empty-title {
	font-weight: 600;
	margin-bottom: 10px;
	color: var(--theme--foreground);
}

.sg__empty-actions {
	display: inline-flex;
	gap: 8px;
}

.sg__drawer-grid {
	height: 100%;
	overflow: auto;
	padding: 16px;
	display: grid;
	gap: 12px;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	align-content: start;
    box-sizing: border-box;
}

.sg__drawer-form {
	height: 100%;
	overflow: auto;
	padding: 16px;
}

.sg__drawer-state {
	grid-column: 1 / -1;
	padding: 12px;
	border-radius: var(--theme--border-radius);
	background: var(--theme--background-subdued);
	color: var(--theme--foreground-subdued);
	font-size: 13px;
}

.sg__drawer-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.sg__drawer-search {
	flex: 1 1 auto;
	min-width: 220px;
}

@media (max-width: 600px) {
	.sg__drawer-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.sg__drawer-search {
		min-width: 0;
	}
}
</style>