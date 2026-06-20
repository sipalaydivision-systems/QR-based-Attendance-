plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val mobileReleaseKeystore = file("edutrack-mobile-release.jks")
if (!mobileReleaseKeystore.exists()) {
    throw org.gradle.api.GradleException("Missing EduTrack mobile release keystore. Refusing to build an APK that would break future updates.")
}

android {
    namespace = "ph.gov.sipalay.attendance"
    compileSdk = flutter.compileSdkVersion
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "ph.gov.sipalay.attendance"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            storeFile = mobileReleaseKeystore
            storePassword = System.getenv("MOBILE_RELEASE_STORE_PASSWORD") ?: "EduTrackMobile2026!"
            keyAlias = System.getenv("MOBILE_RELEASE_KEY_ALIAS") ?: "edutrack-mobile"
            keyPassword = System.getenv("MOBILE_RELEASE_KEY_PASSWORD") ?: "EduTrackMobile2026!"
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
