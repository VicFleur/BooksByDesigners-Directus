<template>
	<div class="homepage-books-grid">
		<!-- Header with add button -->
		<div class="header">
			<v-button
				v-tooltip="'Add Book'"
				icon
				rounded
				secondary
				@click="showDrawer = true"
			>
				<v-icon name="add" />
			</v-button>
			<span class="count" v-if="items.length">{{ items.length }} book{{ items.length !== 1 ? 's' : '' }}</span>
		</div>

		<!-- Loading state -->
		<div v-if="loading" class="grid">
			<div v-for="n in 6" :key="n" class="card skeleton">
				<div class="cover-skeleton"></div>
				<div class="info-skeleton">
					<div class="title-skeleton"></div>
					<div class="subtitle-skeleton"></div>
				</div>
			</div>
		</div>

		<!-- Empty state -->
		<v-info v-else-if="!items.length" icon="library_books" title="No books added">
			Click the + button to add books to the homepage.
		</v-info>

		<!-- Draggable grid -->
		<draggable
			v-else
			v-model="items"
			item-key="id"
			class="grid"
			:animation="150"
			ghost-class="ghost"
			handle=".drag-handle"
			@end="onDragEnd"
		>
			<template #item="{ element }">
				<div class="card">
					<div class="drag-handle">
						<v-icon name="drag_indicator" />
					</div>
					<div class="cover" @click="openItem(element.id)">
						<img
							v-if="getCover(element)"
							:src="getThumbnail(getCover(element))"
							:alt="getTitle(element)"
						/>
						<v-icon v-else name="image" class="placeholder-icon" />
					</div>
					<div class="info" @click="openItem(element.id)">
						<div class="title">{{ getTitle(element) || 'Untitled' }}</div>
						<div class="subtitle">{{ getSubtitle(element) || '—' }}</div>
					</div>
					<v-button
						v-tooltip="'Remove from homepage'"
						class="remove-btn"
						icon
						x-small
						secondary
						@click.stop="removeItem(element)"
					>
						<v-icon name="close" />
					</v-button>
				</div>
			</template>
		</draggable>

		<!-- Add drawer -->
		<v-drawer
			v-model="showDrawer"
			title="Add Book"
			icon="library_books"
			@cancel="showDrawer = false"
		>
			<template #actions>
				<v-button
					v-tooltip="'Done'"
					icon
					rounded
					@click="showDrawer = false"
				>
					<v-icon name="check" />
				</v-button>
			</template>

			<div class="drawer-content">
				<v-input
					v-model="searchQuery"
					placeholder="Search books..."
					:nullable="false"
				>
					<template #prepend>
						<v-icon name="search" />
					</template>
				</v-input>

				<div v-if="searchLoading" class="search-loading">
					<v-progress-circular indeterminate />
				</div>

				<div v-else-if="availableBooks.length" class="available-list">
					<div
						v-for="book in availableBooks"
						:key="book.id"
						class="available-item"
						@click="addItem(book)"
					>
						<div class="available-cover">
							<img
								v-if="getCover(book)"
								:src="getThumbnail(getCover(book))"
								:alt="getTitle(book)"
							/>
							<v-icon v-else name="image" />
						</div>
						<div class="available-info">
							<div class="available-title">{{ getTitle(book) || 'Untitled' }}</div>
							<div class="available-subtitle">{{ getSubtitle(book) || '—' }}</div>
						</div>
						<v-icon name="add_circle" class="add-icon" />
					</div>
				</div>

				<v-info v-else-if="searchQuery" icon="search_off" title="No results">
					No available books found matching "{{ searchQuery }}"
				</v-info>

				<v-info v-else icon="library_books" title="Search for books">
					Start typing to search for books to add.
				</v-info>
			</div>
		</v-drawer>
	</div>
</template>

<script setup lang="ts">
import { ref, watch, inject, computed, onMounted } from 'vue';
import Draggable from 'vuedraggable';

interface Props {
	value: any;
	collection: string;
	field: string;
	primaryKey: string | number;
	relatedCollection?: string;
	foreignKey?: string;
	sortField?: string;
	coverField?: string;
	titleField?: string;
	subtitleField?: string;
}

const props = withDefaults(defineProps<Props>(), {
	relatedCollection: 'books',
	foreignKey: 'homepage',
	sortField: 'sort_homepage',
	coverField: 'cover',
	titleField: 'title',
	subtitleField: 'designer.name',
});

const emit = defineEmits(['input']);

const api = inject<any>('api');
const router = inject<any>('router');

const items = ref<any[]>([]);
const loading = ref(true);
const showDrawer = ref(false);
const searchQuery = ref('');
const searchLoading = ref(false);
const availableBooks = ref<any[]>([]);

// Compute fields to fetch based on subtitleField path
const fieldsToFetch = computed(() => {
	const fields = ['id', props.coverField, props.titleField, props.sortField];
	// Handle nested field paths like "designer.name"
	const subtitleParts = props.subtitleField.split('.');
	if (subtitleParts.length > 1) {
		fields.push(`${subtitleParts[0]}.*`);
	} else {
		fields.push(props.subtitleField);
	}
	return fields;
});

// Load related items
async function loadItems() {
	if (!props.primaryKey || props.primaryKey === '+') {
		loading.value = false;
		return;
	}

	loading.value = true;
	try {
		const response = await api.get(`/items/${props.relatedCollection}`, {
			params: {
				filter: {
					[props.foreignKey]: { _eq: props.primaryKey },
				},
				sort: [props.sortField],
				fields: fieldsToFetch.value,
				limit: -1,
			},
		});
		items.value = response.data.data || [];
	} catch (e) {
		console.error('Failed to load items:', e);
		items.value = [];
	}
	loading.value = false;
}

// Search available books
let searchTimeout: ReturnType<typeof setTimeout>;
watch(searchQuery, (query) => {
	clearTimeout(searchTimeout);
	if (!query) {
		availableBooks.value = [];
		return;
	}
	searchTimeout = setTimeout(() => searchBooks(query), 300);
});

async function searchBooks(query: string) {
	searchLoading.value = true;
	try {
		const currentIds = items.value.map((i) => i.id);
		const response = await api.get(`/items/${props.relatedCollection}`, {
			params: {
				search: query,
				filter: {
					_and: [
						{
							_or: [
								{ [props.foreignKey]: { _null: true } },
								{ [props.foreignKey]: { _neq: props.primaryKey } },
							],
						},
						...(currentIds.length ? [{ id: { _nin: currentIds } }] : []),
					],
				},
				fields: fieldsToFetch.value,
				limit: 20,
			},
		});
		availableBooks.value = response.data.data || [];
	} catch (e) {
		console.error('Failed to search books:', e);
		availableBooks.value = [];
	}
	searchLoading.value = false;
}

// Add item to homepage
async function addItem(book: any) {
	const maxSort = items.value.reduce((max, item) => {
		const sortVal = item[props.sortField] ?? 0;
		return sortVal > max ? sortVal : max;
	}, 0);

	try {
		await api.patch(`/items/${props.relatedCollection}/${book.id}`, {
			[props.foreignKey]: props.primaryKey,
			[props.sortField]: maxSort + 1,
		});

		book[props.foreignKey] = props.primaryKey;
		book[props.sortField] = maxSort + 1;
		items.value.push(book);

		// Remove from available list
		availableBooks.value = availableBooks.value.filter((b) => b.id !== book.id);

		emit('input', items.value.map((i) => i.id));
	} catch (e) {
		console.error('Failed to add item:', e);
	}
}

// Remove item from homepage
async function removeItem(item: any) {
	try {
		await api.patch(`/items/${props.relatedCollection}/${item.id}`, {
			[props.foreignKey]: null,
			[props.sortField]: null,
		});

		items.value = items.value.filter((i) => i.id !== item.id);
		emit('input', items.value.map((i) => i.id));
	} catch (e) {
		console.error('Failed to remove item:', e);
	}
}

// Handle drag end - persist new sort order
async function onDragEnd() {
	const updates = items.value.map((item, index) => ({
		id: item.id,
		[props.sortField]: index + 1,
	}));

	try {
		await api.patch(`/items/${props.relatedCollection}`, updates);
		// Update local state
		items.value.forEach((item, index) => {
			item[props.sortField] = index + 1;
		});
		emit('input', items.value.map((i) => i.id));
	} catch (e) {
		console.error('Failed to update sort order:', e);
		// Reload to get correct state
		await loadItems();
	}
}

// Helper to get nested value from object
function getNestedValue(obj: any, path: string): any {
	return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

function getCover(item: any): string | null {
	const cover = item[props.coverField];
	return typeof cover === 'object' ? cover?.id : cover;
}

function getTitle(item: any): string {
	return item[props.titleField] || '';
}

function getSubtitle(item: any): string {
	return getNestedValue(item, props.subtitleField) || '';
}

function getThumbnail(fileId: string): string {
	return `/assets/${fileId}?fit=cover&width=200&height=280&quality=80`;
}

function openItem(id: string | number) {
	router.push(`/content/${props.relatedCollection}/${id}`);
}

onMounted(() => {
	loadItems();
});

// Reload when primary key changes (e.g., after save)
watch(() => props.primaryKey, (newKey, oldKey) => {
	if (newKey && newKey !== '+' && newKey !== oldKey) {
		loadItems();
	}
});
</script>

<style scoped>
.homepage-books-grid {
	width: 100%;
}

.header {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 16px;
}

.count {
	color: var(--theme--foreground-subdued);
	font-size: 14px;
}

.grid {
	display: grid;
	grid-template-columns: repeat(6, 1fr);
	gap: 16px;
}

@media (max-width: 1400px) {
	.grid {
		grid-template-columns: repeat(4, 1fr);
	}
}

@media (max-width: 1000px) {
	.grid {
		grid-template-columns: repeat(3, 1fr);
	}
}

@media (max-width: 700px) {
	.grid {
		grid-template-columns: repeat(2, 1fr);
	}
}

.card {
	position: relative;
	background: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
	overflow: hidden;
	transition: box-shadow 0.15s ease, transform 0.15s ease;
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.card:hover {
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.card.ghost {
	opacity: 0.5;
	background: var(--theme--primary-background);
	border-color: var(--theme--primary);
}

.drag-handle {
	position: absolute;
	top: 8px;
	left: 8px;
	z-index: 2;
	cursor: grab;
	padding: 4px;
	background: var(--theme--background);
	border-radius: var(--theme--border-radius);
	opacity: 0;
	transition: opacity 0.15s ease;
	color: var(--theme--foreground-subdued);
}

.card:hover .drag-handle {
	opacity: 1;
}

.drag-handle:active {
	cursor: grabbing;
}

.remove-btn {
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 2;
	opacity: 0;
	transition: opacity 0.15s ease;
}

.card:hover .remove-btn {
	opacity: 1;
}

.cover {
	aspect-ratio: 5 / 7;
	background: var(--theme--background-subdued);
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	overflow: hidden;
}

.cover img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.placeholder-icon {
	color: var(--theme--foreground-subdued);
	--v-icon-size: 48px;
}

.info {
	padding: 12px;
	cursor: pointer;
}

.title {
	font-weight: 600;
	font-size: 14px;
	color: var(--theme--foreground);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	margin-bottom: 2px;
}

.subtitle {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* Skeleton loading */
.skeleton {
	pointer-events: none;
}

.cover-skeleton {
	aspect-ratio: 5 / 7;
	background: linear-gradient(
		90deg,
		var(--theme--background-subdued) 0%,
		var(--theme--background-normal) 50%,
		var(--theme--background-subdued) 100%
	);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
}

.info-skeleton {
	padding: 12px;
}

.title-skeleton {
	height: 14px;
	width: 70%;
	background: var(--theme--background-subdued);
	border-radius: 4px;
	margin-bottom: 8px;
}

.subtitle-skeleton {
	height: 12px;
	width: 50%;
	background: var(--theme--background-subdued);
	border-radius: 4px;
}

@keyframes shimmer {
	0% {
		background-position: -200% 0;
	}
	100% {
		background-position: 200% 0;
	}
}

/* Drawer styles */
.drawer-content {
	padding: 20px;
}

.drawer-content .v-input {
	margin-bottom: 20px;
}

.search-loading {
	display: flex;
	justify-content: center;
	padding: 40px;
}

.available-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.available-item {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px;
	background: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
	cursor: pointer;
	transition: background 0.15s ease;
	border: var(--theme--border-width) solid var(--theme--border-color-subdued);
}

.available-item:hover {
	background: var(--theme--background-accent);
	border-color: var(--theme--primary);
}

.available-cover {
	width: 48px;
	height: 64px;
	background: var(--theme--background-subdued);
	border-radius: 4px;
	overflow: hidden;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.available-cover img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.available-cover .v-icon {
	color: var(--theme--foreground-subdued);
}

.available-info {
	flex: 1;
	min-width: 0;
}

.available-title {
	font-weight: 600;
	font-size: 14px;
	color: var(--theme--foreground);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.available-subtitle {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.add-icon {
	color: var(--theme--primary);
	flex-shrink: 0;
}
</style>

