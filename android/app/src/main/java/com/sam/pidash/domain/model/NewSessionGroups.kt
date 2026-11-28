package com.sam.pidash.domain.model

/**
 * Choices offered by the "new session" sheet when the user wants the new Live Pi to
 * land in an existing group.
 *
 * The list is a straight projection of the machine's own groups (same ids, same order,
 * same names) so the phone never invents a group the Dashboard does not know. A group
 * with a blank id is dropped because the membership endpoint would reject it, and the
 * "no group" choice is not part of the list: an empty selection means "keep today's
 * behaviour", i.e. the session is created exactly as before and stays ungrouped.
 */
fun newSessionGroupChoices(organization: LiveOrganization): List<LiveGroup> =
    organization.groups
        .filter { it.loaded() }
        .distinctBy { it.id }

private fun LiveGroup.loaded(): Boolean = id.isNotBlank() && name.isNotBlank()