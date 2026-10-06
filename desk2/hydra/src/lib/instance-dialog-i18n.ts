export type CliDialogNamespace = 'cliInstances' | 'codexInstances' | 'dshInstances' | 'freeInstances'

// Keep these as full, static key paths. Besides making the reusable dialogs type-safe, this lets
// the locale audit verify both namespaces instead of treating template-built paths as unknown.
export const CLI_INSTANCE_DIALOG_KEYS = {
  cliInstances: {
    nameLabel: 'cliInstances.nameLabel',
    namePlaceholder: 'cliInstances.namePlaceholder',
    renameDialogTitle: 'cliInstances.renameDialogTitle',
    renameDialogDescription: 'cliInstances.renameDialogDescription',
    renameDialogSubmit: 'cliInstances.renameDialogSubmit',
    renameDialogRenaming: 'cliInstances.renameDialogRenaming',
  },
  dshInstances: {
    nameLabel: 'dshInstances.nameLabel',
    namePlaceholder: 'dshInstances.namePlaceholder',
    createDialogTitle: 'dshInstances.createDialogTitle',
    createDialogDescription: 'dshInstances.createDialogDescription',
    createDialogSubmit: 'dshInstances.createDialogSubmit',
    createDialogCreating: 'dshInstances.createDialogCreating',
    renameDialogTitle: 'dshInstances.renameDialogTitle',
    renameDialogDescription: 'dshInstances.renameDialogDescription',
    renameDialogSubmit: 'dshInstances.renameDialogSubmit',
    renameDialogRenaming: 'dshInstances.renameDialogRenaming',
  },
  codexInstances: {
    nameLabel: 'codexInstances.nameLabel',
    namePlaceholder: 'codexInstances.namePlaceholder',
    createDialogTitle: 'codexInstances.createDialogTitle',
    createDialogDescription: 'codexInstances.createDialogDescription',
    createDialogSubmit: 'codexInstances.createDialogSubmit',
    createDialogCreating: 'codexInstances.createDialogCreating',
    renameDialogTitle: 'codexInstances.renameDialogTitle',
    renameDialogDescription: 'codexInstances.renameDialogDescription',
    renameDialogSubmit: 'codexInstances.renameDialogSubmit',
    renameDialogRenaming: 'codexInstances.renameDialogRenaming',
  },
  freeInstances: {
    nameLabel: 'freeInstances.nameLabel',
    namePlaceholder: 'freeInstances.namePlaceholder',
    createDialogTitle: 'freeInstances.createDialogTitle',
    createDialogDescription: 'freeInstances.createDialogDescription',
    createDialogSubmit: 'freeInstances.createDialogSubmit',
    createDialogCreating: 'freeInstances.createDialogCreating',
    renameDialogTitle: 'freeInstances.renameDialogTitle',
    renameDialogDescription: 'freeInstances.renameDialogDescription',
    renameDialogSubmit: 'freeInstances.renameDialogSubmit',
    renameDialogRenaming: 'freeInstances.renameDialogRenaming',
  },
} as const

/** The delete dialog (DeleteInstanceDialog.vue) on all four instance tables. The type-the-name prompt
 *  and the copy-name chip are one shared wording (instances.deleteDialogTypeName), not per table. */
export type DeleteDialogNamespace = 'instances' | Exclude<CliDialogNamespace, 'freeInstances'>

export const DELETE_DIALOG_KEYS = {
  instances: {
    title: 'instances.deleteDialogTitle',
    description: 'instances.deleteDialogDescription',
    placeholder: 'instances.deleteDialogPlaceholder',
    mismatch: 'instances.deleteDialogMismatch',
    submit: 'instances.deleteDialogSubmit',
    deleting: 'instances.deleteDialogDeleting',
  },
  cliInstances: {
    title: 'cliInstances.deleteDialogTitle',
    description: 'cliInstances.deleteDialogDescription',
    placeholder: 'cliInstances.deleteDialogPlaceholder',
    mismatch: 'cliInstances.deleteDialogMismatch',
    submit: 'cliInstances.deleteDialogSubmit',
    deleting: 'cliInstances.deleteDialogDeleting',
  },
  codexInstances: {
    title: 'codexInstances.deleteDialogTitle',
    description: 'codexInstances.deleteDialogDescription',
    placeholder: 'codexInstances.deleteDialogPlaceholder',
    mismatch: 'codexInstances.deleteDialogMismatch',
    submit: 'codexInstances.deleteDialogSubmit',
    deleting: 'codexInstances.deleteDialogDeleting',
  },
  dshInstances: {
    title: 'dshInstances.deleteDialogTitle',
    description: 'dshInstances.deleteDialogDescription',
    placeholder: 'dshInstances.deleteDialogPlaceholder',
    mismatch: 'dshInstances.deleteDialogMismatch',
    submit: 'dshInstances.deleteDialogSubmit',
    deleting: 'dshInstances.deleteDialogDeleting',
  },
} as const satisfies Record<DeleteDialogNamespace, Record<string, string>>
