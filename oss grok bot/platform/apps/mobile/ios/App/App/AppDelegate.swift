import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}


// The bundled client owns the native bridge. The remote workspace gets a plain
// WKWebView with no Capacitor plugins or native execution bridge.
import WebKit
import CryptoKit
import Security

class WorkshopBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrimaryHostPlugin())
    }
}

@objc(PrimaryHostPlugin)
public class PrimaryHostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrimaryHostPlugin"
    public let jsName = "PrimaryHost"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise)]

    @objc func connect(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text),
              url.scheme == "https", url.host != nil, url.user == nil,
              url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            call.reject("Enter the trusted HTTPS address of your primary host.")
            return
        }
        DispatchQueue.main.async {
            let view = PrimaryHostViewController(url: url)
            let navigation = UINavigationController(rootViewController: view)
            navigation.modalPresentationStyle = .fullScreen
            self.bridge?.viewController?.present(navigation, animated: true) { call.resolve() }
        }
    }
}

final class OrbitNotifyBridge: NSObject, WKScriptMessageHandler {
    weak var owner: PrimaryHostViewController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.showAttention(message.body)
    }
}

class PrimaryHostViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let hostURL: URL
    private var browser: WKWebView!
    private let notifyBridge = OrbitNotifyBridge()
    init(url: URL) { self.hostURL = url; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(url:)") }
    private func sameHost(_ url: URL) -> Bool {
        url.scheme == hostURL.scheme && url.host == hostURL.host && (url.port ?? 443) == (hostURL.port ?? 443)
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Primary host"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Hosts", style: .plain, target: self, action: #selector(done))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(back))
        notifyBridge.owner = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(notifyBridge, name: "orbitNotify")
        browser = WKWebView(frame: .zero, configuration: configuration)
        browser.navigationDelegate = self; browser.uiDelegate = self
        browser.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(browser)
        NSLayoutConstraint.activate([browser.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),browser.bottomAnchor.constraint(equalTo: view.bottomAnchor),browser.leadingAnchor.constraint(equalTo: view.leadingAnchor),browser.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        browser.load(URLRequest(url: hostURL))
    }
    func showAttention(_ body: Any) {
        guard let payload = body as? [String: Any],
              let title = payload["title"] as? String, !title.isEmpty, title.count <= 200,
              let text = payload["body"] as? String, text.count <= 4000,
              let tag = payload["tag"] as? String, !tag.isEmpty, tag.count <= 200 else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = String(text.prefix(500))
        let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
    @objc private func done() { dismiss(animated: true) }
    @objc private func back() { if browser.canGoBack { browser.goBack() } }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if sameHost(url) || navigationAction.targetFrame?.isMainFrame == false && url.scheme == "about" {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, sameHost(url) { browser.load(URLRequest(url: url)) }
        return nil
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == hostURL.host,
              challenge.protectionSpace.port == (hostURL.port ?? 443),
              let trust = challenge.protectionSpace.serverTrust,
              let certificate = SecTrustGetCertificateAtIndex(trust, 0) else {
            completionHandler(.performDefaultHandling, nil); return
        }
        if SecTrustEvaluateWithError(trust, nil) { completionHandler(.performDefaultHandling, nil); return }
        let bytes = SecCertificateCopyData(certificate) as Data
        let fingerprint = SHA256.hash(data: bytes).map { String(format: "%02X", $0) }.joined(separator: ":")
        // A selected leaf can be a trust anchor, while hostname and expiry remain
        // evaluated by Security.framework. No global TLS exception is installed.
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, hostURL.host! as CFString))
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        guard SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let key = "workshop-host-pin:" + hostURL.absoluteString
        if UserDefaults.standard.string(forKey: key) == fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust)); return
        }
        let alert = UIAlertController(title: "Verify your primary host", message: "Compare this fingerprint with Primary host settings on your Windows app. Only trust it if every character matches.\n\n" + fingerprint, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(.cancelAuthenticationChallenge, nil) })
        alert.addAction(UIAlertAction(title: "Fingerprint matches", style: .default) { _ in
            UserDefaults.standard.set(fingerprint, forKey: key)
            completionHandler(.useCredential, URLCredential(trust: trust))
        })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let alert = UIAlertController(title: "Primary host is unreachable", message: "Keep your Windows host running and connected. Its HTTPS certificate must be trusted by this iPhone. " + error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Retry", style: .default) { _ in webView.load(URLRequest(url: self.hostURL)) })
        alert.addAction(UIAlertAction(title: "Choose host", style: .cancel) { _ in self.done() })
        present(alert, animated: true)
    }
}
