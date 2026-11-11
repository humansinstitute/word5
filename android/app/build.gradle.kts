plugins { id("com.android.application"); id("org.jetbrains.kotlin.plugin.compose") }
android {
    namespace = "ai.otherstuff.word5"
    compileSdk { version = release(37) { minorApiLevel = 2 } }
    defaultConfig {
        applicationId = "ai.otherstuff.word5"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "1.0.2-test"
        buildConfigField("String", "API_BASE", "\"https://otherstuff.ai/word5/\"")
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    signingConfigs {
        create("release") {
            val location = providers.environmentVariable("WORD5_KEYSTORE").orNull
            if (location != null) {
                storeFile = file(location)
                storePassword = providers.environmentVariable("WORD5_STORE_PASSWORD").orNull
                keyAlias = "word5"
                keyPassword = providers.environmentVariable("WORD5_KEY_PASSWORD").orNull
            }
        }
    }
    buildTypes { debug { applicationIdSuffix = ".visualreview" }; release { signingConfig = signingConfigs.getByName("release"); isMinifyEnabled = false } }
    testOptions { unitTests.isReturnDefaultValues = true }
}
dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.google.zxing:core:3.5.3")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("fr.acinq.secp256k1:secp256k1-kmp:0.24.0")
    implementation("fr.acinq.secp256k1:secp256k1-kmp-jni-android:0.24.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("fr.acinq.secp256k1:secp256k1-kmp-jni-jvm:0.24.0")
}
