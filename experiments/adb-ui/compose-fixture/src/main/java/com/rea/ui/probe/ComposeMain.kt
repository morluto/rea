package com.rea.ui.probe

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

/** Permission-free oracle for virtual/merged Compose accessibility nodes. */
class ComposeMain : ComponentActivity() {
    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var value by remember { mutableStateOf("") }
            var status by remember { mutableStateOf("Compose ready") }
            MaterialTheme {
                Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars).padding(24.dp).semantics { testTagsAsResourceId = true }) {
                    Text(status, Modifier.testTag("com.rea.ui.probe:id/status"))
                    TextField(value, { value = it }, Modifier.testTag("com.rea.ui.probe:id/entry"), label = { Text("Entry") })
                    Button({ status = "Compose tapped" }, Modifier.testTag("com.rea.ui.probe:id/sign_in")) { Text("Compose sign in") }
                    Row {
                        Button({ status = "Compose duplicate 1" }, Modifier.testTag("com.rea.ui.probe:id/duplicate_one")) { Text("Duplicate") }
                        Button({ status = "Compose duplicate 2" }, Modifier.testTag("com.rea.ui.probe:id/duplicate_two")) { Text("Duplicate") }
                    }
                    Button({}, Modifier.testTag("com.rea.ui.probe:id/disabled"), enabled = false) { Text("Disabled") }
                    LazyColumn(Modifier.weight(1f).testTag("com.rea.ui.probe:id/scroll")) {
                        items((0 until 50).toList()) { number ->
                            Text("Compose row $number", Modifier.fillMaxWidth().padding(16.dp))
                        }
                    }
                }
            }
        }
    }
}
