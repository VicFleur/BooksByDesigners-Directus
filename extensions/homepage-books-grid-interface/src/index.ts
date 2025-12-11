import { defineInterface } from '@directus/extensions-sdk';
import InterfaceComponent from './interface.vue';

export default defineInterface({
	id: 'homepage-books-grid',
	name: 'Homepage Books Grid',
	icon: 'view_module',
	description: 'Sortable 6-column card grid for managing homepage books',
	component: InterfaceComponent,
	types: ['alias'],
	localTypes: ['o2m'],
	group: 'relational',
	options: ({ collection }) => [
		{
			field: 'relatedCollection',
			name: 'Related Collection',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'books',
				},
			},
			schema: {
				default_value: 'books',
			},
		},
		{
			field: 'foreignKey',
			name: 'Foreign Key Field',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'homepage',
				},
			},
			schema: {
				default_value: 'homepage',
			},
		},
		{
			field: 'sortField',
			name: 'Sort Field',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'sort_homepage',
				},
			},
			schema: {
				default_value: 'sort_homepage',
			},
		},
		{
			field: 'coverField',
			name: 'Cover Image Field',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'cover',
				},
			},
			schema: {
				default_value: 'cover',
			},
		},
		{
			field: 'titleField',
			name: 'Title Field',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'title',
				},
			},
			schema: {
				default_value: 'title',
			},
		},
		{
			field: 'subtitleField',
			name: 'Subtitle Field Path',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'designer.name',
				},
			},
			schema: {
				default_value: 'designer.name',
			},
		},
	],
});

