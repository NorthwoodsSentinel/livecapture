// Set the system default output device by name; prints the previous device name for restore.
// Usage: swift set-output.swift "NWS Multi-Output"
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
func name(_ id: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
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

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "NWS Multi-Output"
var outAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)

var current = AudioDeviceID(0)
var size = UInt32(MemoryLayout<AudioDeviceID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &outAddr, 0, nil, &size, &current)
print("previous: \(name(current) ?? "unknown")")

guard let targetID = deviceIDs().first(where: { name($0) == target }) else {
    print("FAILED: no output device named \(target)"); exit(1)
}
var newID = targetID
let status = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &outAddr, 0, nil,
                                        UInt32(MemoryLayout<AudioDeviceID>.size), &newID)
print(status == noErr ? "now: \(target)" : "FAILED: OSStatus \(status)")
