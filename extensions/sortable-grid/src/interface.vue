<template>
<div>{{ cardCover }}</div>
</template>

<script setup>
import { computed, toRefs } from 'vue';
import { useStores } from '@directus/extensions-sdk';

const props = defineProps({
    value: {
        type: Array,
        default: () => []
    },
    primaryKey: {
        type: String,
        default: 'id'
    },
    collection: {
        type: String,
        required: true
    },
    field: {
        type: String,
        required: true
    },
    width: {
        type: String,
        default: 'full'
    },
    disabled: {
        type: Boolean,
        default: false
    },
    layout: {
        type: String,
        default: 'grid'
    },
    tableSpacing: {
        type: String,
        default: 'cozy'
    },
    version: {
        type: String,
        default: '1.0.0'
    },
    fields: {
        type: Array,
        default: () => ['id']
    },
    template: {
        type: String,
        default: null
    },
    enableCreate: {
        type: Boolean,
        default: true
    },
    enableSelect: {
        type: Boolean,
        default: true
    },
    filter: {
        type: Object,
        default: () => null
    },
    enableSearchFilter: {
        type: Boolean,
        default: false
    },
    enableLink: {
        type: Boolean,
        default: true
    },
    limit: {
        type: Number,
        default: 1000
    },
    sort: {
        type: String,
        default: 'id'
    },
    sortDirection: {
        type: String,
        default: 'asc'
    }
});

const emit = defineEmits(['input']);

const { collection, field, primaryKey, version } = toRefs(props);
const { useFieldsStore } = useStores();
const fieldsStore = useFieldsStore();

const fieldMeta = computed(() => fieldsStore.getField(collection.value, field.value)?.meta || {});
const options = computed(() => fieldMeta.value?.options ?? {});

const cardCover = computed(() => options.value.card_cover || null);
const cardTitle = computed(() => options.value.card_title || null);
const cardSubtitle = computed(() => options.value.card_subtitle || null);
const columns = computed(() => options.value.columns || 6);
const limit = computed(() => options.value.limit || 1000);


</script>