import { defineInterface } from '@directus/extensions-sdk';
import InterfaceO2M from './interface.vue';

export default defineInterface({
    id: 'sortable-grid',
    name: 'Sortable Grid',
    icon: 'grid_view',
    description: 'Edit a one-to-many relation using a grid of related items.',
    // For O2M interfaces you must declare alias + localTypes + relational
    types: ['alias'],
    localTypes: ['o2m'],
    group: 'relational',
    relational: true,
    component: InterfaceO2M,
    recommendedDisplays: ['related-values'],
    // Options are dynamic so we can prefill collection context just like core list-o2m
    options: ({ relations, field: { meta } }) => {
        const collection = relations.o2m?.collection;
        const opts = meta?.options ?? {};

        return [
            {
                field: 'related_collection',
                name: 'Related Collection',
                type: 'string',
                meta: {
                    width: 'half',
                    interface: 'system-collection',
                    note: 'Manually specify the related collection if auto-detection fails.'
                }
            },
            {
                field: 'foreign_key',
                name: 'Foreign Key Field',
                type: 'string',
                meta: {
                    width: 'half',
                    interface: 'input',
                    note: 'Manually specify the field in the related collection that points to this item.'
                }
            },
            {
                field: 'card_cover',
                name: 'Card Cover',
                type: 'string',
                meta: { width: 'full', interface: 'system-field', options: { collectionName: collection } }
            },
            {
                field: 'card_title',
                name: 'Card Title',
                type: 'string',
                meta: { width: 'half', interface: 'system-field-tree', options: { collectionName: collection } }
            },
            {
                field: 'card_subtitle_key',
                name: 'Card Subtitle',
                type: 'string',
                meta: { width: 'half', interface: 'system-field-tree', options: { collectionName: collection } }
            },
            {
                field: 'columns',
                name: 'Columns',
                type: 'integer',
                schema: { default_value: 6, min: 1, max: 12 },
                meta: { width: 'half', interface: 'input' }
            },
            {
                field: 'limit',
                name: '$t:per_page',
                type: 'integer',
                schema: { default_value: 1000 },
                meta: { width: 'half', interface: 'input' }
            },
            {
                field: 'sort_field',
                name: 'Sort Field',
                type: 'string',
                meta: {
                    width: 'full',
                    interface: 'system-field',
                    note: 'Optional override. Used when the relationship sort field cannot be detected automatically.',
                    options: { collectionName: collection }
                }
            }
        ];
    },
});