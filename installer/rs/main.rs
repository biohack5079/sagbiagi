use std::process::{Command, Stdio};
use std::net::TcpStream;
use std::time::{Duration, Instant};
use std::{thread, env, process, fs, io::{self, Write}};
use std::io::Cursor;
use opener;

const OLLAMA_SETUP_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
const DEFAULT_MODEL: &str = "gemma3:4b-it-q4_K_M";

async fn download_and_install_ollama() -> Result<(), Box<dyn std::error::Error>> {
    println!("📥 Ollama not found. Downloading installer...");
    let response = reqwest::get(OLLAMA_SETUP_URL).await?;
    let mut dest = {
        let fname = env::temp_dir().join("OllamaSetup.exe");
        (fname, fs::File::create(&fname)?)
    };
    let mut content = Cursor::new(response.bytes().await?);
    std::io::copy(&mut content, &mut dest.1)?;
    
    println!("⚙️ Running Ollama installer (Silent)...");
    let status = Command::new(dest.0)
        .arg("/SILENT")
        .arg("/NORESTART")
        .status()?;

    if !status.success() {
        return Err("Failed to install Ollama".into());
    }
    println!("✅ Ollama installation complete.");
    Ok(())
}

fn ensure_model_pulled(model: &str) {
    println!("📦 Checking for model: {}...", model);
    let output = Command::new("ollama")
        .args(["list"])
        .output();

    let already_has = if let Ok(out) = output {
        String::from_utf8_lossy(&out.stdout).contains(model)
    } else {
        false
    };

    if !already_has {
        println!("🚚 Pulling model {} (This may take a while)...", model);
        let _ = Command::new("ollama")
            .args(["pull", model])
            .status();
    } else {
        println!("✅ Model already exists.");
    }
}

fn has_hf_token() -> bool {
    fs::read_to_string("signaling/.env")
        .map(|c| c.contains("HF_TOKEN="))
        .unwrap_or(false)
}

fn prompt_and_save_hf_token() {
    println!("\n🔑 HuggingFace Access Token (optional)");
    println!("Gemma 3 などの制限付きモデルの初回ダウンロードに必要です。");
    print!("Enter Token (input will be hidden): ");
    io::stdout().flush().unwrap();

    let token = rpassword::read_password().unwrap_or_default();
    let token = token.trim();

    if !token.is_empty() {
        let _ = fs::create_dir_all("signaling");
        let content = format!("HF_TOKEN={}\n", token);
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open("signaling/.env") {
            let _ = file.write_all(content.as_bytes());
            println!("✅ Token saved to signaling/.env");
        }
    }
}

#[tokio::main]
async fn main() {
    println!("--- 🤖 SAGBI AGI Multi-Platform Launcher ---");

    let exe_suffix = env::consts::EXE_SUFFIX; // Windowsなら ".exe"、Linuxなら空文字
    let sagbi_url = "https://sagbiagi.pages.dev/?app=1";

    // 0. HuggingFace Token Check
    if !has_hf_token() {
        prompt_and_save_hf_token();
    }

    // 1. Check Ollama
    if !check_command_exists("ollama") {
        if cfg!(windows) {
            if let Err(e) = download_and_install_ollama().await {
                eprintln!("❌ Error installing Ollama: {}", e);
                return;
            }
        } else {
            eprintln!("[Error] Ollama is not installed. Please run: curl -fsSL https://ollama.com/install.sh | sh");
            return;
        }
    }

    // Ensure model is present
    ensure_model_pulled(DEFAULT_MODEL);

    // 2. Start Signaling Server
    // バイナリ名はOSに合わせて自動切り替え (sagbi-server or sagbi-server.exe)
    let server_bin = format!("./signaling/sagbi-server{}", exe_suffix);
    println!("[1/2] Starting Signaling Server...");

    let mut server = Command::new(&server_bin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|_| {
            // パッケージ化後のパス（カレントディレクトリにある場合）
            let fallback_bin = format!("./sagbi-server{}", exe_suffix);
            Command::new(fallback_bin).spawn().expect("Failed to start signaling server binary")
        });

    let server_pid = server.id();

    // 終了時のクリーンアップ（Ctrl+C）
    ctrlc::set_handler(move || {
        println!("\nShutting down SAGBI services...");
        let _ = Command::new(if cfg!(windows) { "taskkill" } else { "kill" })
            .args(if cfg!(windows) { vec!["/F", "/PID", &server_pid.to_string()] } else { vec![&server_pid.to_string()] })
            .status();
        process::exit(0);
    }).expect("Error setting Ctrl-C handler");

    // 3. Wait for Port
    wait_for_port(8080);
    println!("✅ Signaling server is online.");

    // 4. Open HP (Browser)
    println!("[2/2] Opening SAGBI DANCE FLOOR...");
    if let Err(e) = opener::open(sagbi_url) {
        eprintln!("Failed to open browser: {}. Please visit: {}", e, sagbi_url);
    }

    println!("\n--- SAGBI AGI is running ---");
    println!("Press Ctrl+C to stop.");

    // サーバープロセスの待機
    server.wait().unwrap();
}

fn check_command_exists(cmd: &str) -> bool {
    let check_cmd = if cfg!(windows) { "where" } else { "which" };
    Command::new(check_cmd)
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn wait_for_port(port: u16) {
    let addr = format!("127.0.0.1:{}", port);
    let timeout = Duration::from_secs(30);
    let start = Instant::now();

    while start.elapsed() < timeout {
        if TcpStream::connect_with_timeout(&addr.parse().unwrap(), Duration::from_millis(500)).is_ok() {
            println!();
            return;
        }
        thread::sleep(Duration::from_millis(1000));
        print!("."); 
        io::stdout().flush().unwrap();
    }
    eprintln!("\nTimeout waiting for port {}", port);
}