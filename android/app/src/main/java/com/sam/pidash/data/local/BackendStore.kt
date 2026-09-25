package com.sam.pidash.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.sam.pidash.data.remote.pidashJson
import com.sam.pidash.domain.model.Backend
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer

private val Context.configStore: DataStore<Preferences> by preferencesDataStore(name = "pidash_config")

/** Persists the list of backends (servers) as a JSON blob in DataStore. */
class BackendStore(private val context: Context) {

    private val keyBackends = stringPreferencesKey("backends")

    val backends: Flow<List<Backend>> = context.configStore.data.map { prefs ->
        val raw = prefs[keyBackends] ?: return@map emptyList()
        runCatching {
            pidashJson.decodeFromString(ListSerializer(Backend.serializer()), raw)
        }.getOrDefault(emptyList())
    }

    suspend fun save(list: List<Backend>) {
        val encoded = pidashJson.encodeToString(ListSerializer(Backend.serializer()), list)
        context.configStore.edit { it[keyBackends] = encoded }
    }
}
