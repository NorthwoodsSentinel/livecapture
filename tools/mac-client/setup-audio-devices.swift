// livecapture Mac client — create the two composite audio devices BlackHole needs (CeeCee, 2026-06-07)
//   NWS Multi-Output  = speakers + BlackHole (stacked)  → set as OUTPUT so you hear the call WHILE BlackHole taps it
//   NWS Aggregate     = mic + BlackHole                 → capture.sh input for full-call capture (both sides)
// Idempotent: skips creation if a device with the same UID already exists.
// Run: swift setup-audio-devices.swift            (no sudo; devices persist across reboots)
// Undo: open Audio MIDI Setup, delete "NWS Multi-Output" / "NWS Aggregate"
import CoreAudio
import Foundation

func deviceIDs() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
    return ids
}

func stringProp(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
    }
    guard status == noErr, let s = value else { return nil }
    return s as String
}

func uidFor(name: String) -> String? {
    for id in deviceIDs() where stringProp(id, kAudioObjectPropertyName) == name {
        return stringProp(id, kAudioDevicePropertyDeviceUID)
    }
    return nil
}

func createComposite(name: String, uid: String, subUIDs: [String], master: String, stacked: Bool) {
    if uidFor(name: name) != nil { print("exists, skipping: \(name)"); return }
    var desc: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: name,
        kAudioAggregateDeviceUIDKey as String: uid,
        kAudioAggregateDeviceSubDeviceListKey as String: subUIDs.map {
            [kAudioSubDeviceUIDKey as String: $0,
             // drift-compensate every sub-device except the clock master
             kAudioSubDeviceDriftCompensationKey as String: $0 == master ? 0 : 1]
        },
        kAudioAggregateDeviceMainSubDeviceKey as String: master,
    ]
    if stacked { desc[kAudioAggregateDeviceIsStackedKey as String] = 1 }  // stacked = Multi-Output
    var aggID = AudioDeviceID(0)
    let status = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &aggID)
    print(status == noErr ? "created: \(name) (id \(aggID))" : "FAILED \(name): OSStatus \(status)")
}

// Resolve sub-device UIDs by name — names are stable per-machine; edit here for a different Mac.
guard let blackhole = uidFor(name: "BlackHole 2ch") else {
    print("FATAL: BlackHole 2ch not found — is the driver installed/registered?"); exit(1)
}
guard let mic = uidFor(name: "MacBook Air Microphone") else {
    print("FATAL: built-in mic not found"); exit(1)
}
guard let speakers = uidFor(name: "MacBook Air Speakers") else {
    print("FATAL: built-in speakers not found"); exit(1)
}

createComposite(name: "NWS Multi-Output", uid: "nws-multi-output",
                subUIDs: [speakers, blackhole], master: speakers, stacked: true)
createComposite(name: "NWS Aggregate", uid: "nws-aggregate",
                subUIDs: [blackhole, mic], master: blackhole, stacked: false)
