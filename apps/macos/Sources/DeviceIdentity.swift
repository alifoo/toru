import Foundation
import Security

struct DeviceIdentity: Codable {
    let deviceId: String
    let accessToken: String
    let accessExpiresAt: Double
    let refreshToken: String
    let refreshExpiresAt: Double
}

/// Credentials are scoped to the exact server origin; no token in preferences or capture journals.
struct DeviceKeychain {
    private static func query(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         // tools.toru.mac.device for the released app; a development build (other bundle id) keeps its own items.
         kSecAttrService as String: "\(Bundle.main.bundleIdentifier ?? "tools.toru.mac").device",
         kSecAttrAccount as String: server]
    }
    static func load(server: String) throws -> DeviceIdentity? {
        var request = query(server)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw keychainError(status) }
        return try JSONDecoder().decode(DeviceIdentity.self, from: data)
    }
    static func save(_ identity: DeviceIdentity, server: String) throws {
        let data = try JSONEncoder().encode(identity)
        let attributes: [String: Any] = [kSecValueData as String: data,
                                       kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query(server) as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let added = SecItemAdd(query(server).merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw keychainError(added) }
        } else if updated != errSecSuccess { throw keychainError(updated) }
    }
    static func remove(server: String) throws {
        let status = SecItemDelete(query(server) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
    }
    private static func keychainError(_ status: OSStatus) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Toru could not access its saved device credential in Keychain (\(status))."])
    }
}

/// Never forward a pairing code, refresh credential or video to a redirect target.
final class ToruNetwork: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let delegate = ToruNetwork()
    static let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
