/**
 * SAGBI Installer — Windows exe source (C++ / Win32 API)
 *
 * This installer:
 *   1. Downloads and installs Ollama
 *   2. Pulls the default model (gemma3:4b-it-q4_K_M)
 *   3. Allows adding additional models
 *   4. Opens the SAGBI AGI homepage on completion
 *
 * Build with MSVC:
 *   cl /EHsc /Fe:sagbi_install.exe sagbi_installer.cpp
 *      shell32.lib urlmon.lib user32.lib
 *
 * Build with MinGW:
 *   x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp
 *      -lshell32 -lurlmon -luser32 -mwindows -static
 */

#include <windows.h>
#include <urlmon.h>
#include <shellapi.h>
#include <string>
#include <sstream>
#include <vector>
#include <shlobj.h>
#include <fstream>

#pragma comment(lib, "urlmon.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

// ── Configuration ────────────────────────────────────────────
static const wchar_t* OLLAMA_DOWNLOAD_URL =
    L"https://ollama.com/download/OllamaSetup.exe";
static const wchar_t* SIGNALING_SERVER_URL = 
    L"https://github.com/biohack5079/sagbi/releases/download/v1.0.0/sagbi-server-win.exe";
static const wchar_t* DEFAULT_MODEL = L"gemma3:4b-it-q4_K_M";
static const wchar_t* SAGBI_URL     = L"https://sagbuntu.web.app/";
static const wchar_t* WINDOW_TITLE  = L"SAGBI AGI Installer";

// Control IDs
#define IDC_STATUS_LABEL  2001
#define IDC_PROGRESS_LABEL 2002
#define IDC_INSTALL_BTN    2003
#define IDC_MODEL_EDIT     2004
#define IDC_ADD_MODEL_BTN  2005
#define IDC_MODEL_LIST     2006
#define IDC_OPEN_HP_BTN    2007
#define IDC_SELECT_RAG_BTN 2008
#define IDC_SELECT_HIST_BTN 2009

// ── Globals ──────────────────────────────────────────────────
static HWND hStatus, hProgress, hInstallBtn, hModelEdit, hAddModelBtn;
static HWND hModelList, hOpenHpBtn, hRagPathLabel, hHistPathLabel;
static std::vector<std::wstring> additionalModels;
static std::wstring selectedRagPath = L"未設定 (デフォルトを使用)";
static std::wstring selectedHistPath = L"未設定 (保存しない)";
static bool installComplete = false;

// ── Helpers ──────────────────────────────────────────────────
void setStatus(const wchar_t* text) {
    SetWindowTextW(hStatus, text);
}

void setProgress(const wchar_t* text) {
    SetWindowTextW(hProgress, text);
}

bool downloadFile(const wchar_t* url, const wchar_t* dest) {
    HRESULT hr = URLDownloadToFileW(NULL, url, dest, 0, NULL);
    return SUCCEEDED(hr);
}

bool runCommand(const wchar_t* cmd, bool wait = true) {
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {};
    std::wstring cmdStr(cmd);
    // CreateProcessW needs mutable buffer
    std::vector<wchar_t> buf(cmdStr.begin(), cmdStr.end());
    buf.push_back(0);

    if (!CreateProcessW(NULL, buf.data(), NULL, NULL, FALSE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        return false;
    }
    if (wait) {
        WaitForSingleObject(pi.hProcess, INFINITE);
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return true;
}

// ── Install worker (runs in a thread) ────────────────────────
DWORD WINAPI installWorker(LPVOID lpParam) {
    HWND hwnd = (HWND)lpParam;

    // 設定の保存 (signaling/.env に書き出す)
    CreateDirectoryW(L"signaling", NULL);
    std::wofstream envFile(L"signaling/.env");
    if (selectedRagPath != L"未設定 (デフォルトを使用)") {
        envFile << L"RAG_DIR=" << selectedRagPath << std::endl;
    }
    if (selectedHistPath != L"未設定 (保存しない)") {
        envFile << L"HISTORY_DIR=" << selectedHistPath << std::endl;
    }
    envFile.close();

    // 起動用バッチファイル (run_sagbi.bat) の作成
    // start_sagbi.sh の Windows版としての役割を担います
    std::wofstream batFile(L"run_sagbi.bat");
    batFile << L"@echo off" << std::endl;
    batFile << L"echo Starting SAGBI AGI Services..." << std::endl;
    batFile << L"start /b ollama serve" << std::endl;
    batFile << L"timeout /t 5" << std::endl;
    batFile << L"start /b sagbi-server.exe" << std::endl;
    batFile << L"timeout /t 2" << std::endl;
    batFile << L"start " << SAGBI_URL << std::endl;
    batFile.close();

    // Step 1: Download Ollama installer
    setStatus(L"Ollama をダウンロード中...");
    setProgress(L"[1/4] Downloading OllamaSetup.exe");

    wchar_t tempPath[MAX_PATH];
    GetTempPathW(MAX_PATH, tempPath);
    std::wstring installerPath = std::wstring(tempPath) + L"OllamaSetup.exe";
    std::wstring serverPath = L"sagbi-server.exe";

    if (!downloadFile(OLLAMA_DOWNLOAD_URL, installerPath.c_str())) {
        setStatus(L"❌ Ollama のダウンロードに失敗しました");
        setProgress(L"");
        EnableWindow(hInstallBtn, TRUE);
        return 1;
    }

    // Step 2: Download Signaling Server
    setStatus(L"シグナリングサーバーをダウンロード中...");
    setProgress(L"[2/4] Downloading Go signaling server");
    if (!downloadFile(SIGNALING_SERVER_URL, serverPath.c_str())) {
        setStatus(L"⚠ サーバーのダウンロードに失敗しました。後で手動で配置してください。");
    }

    // Step 3: Run Ollama installer (silent)
    setStatus(L"Ollama をインストール中...");
    setProgress(L"[3/4] Installing Ollama");

    std::wstring installCmd = L"\"" + installerPath + L"\" /SILENT /NORESTART";
    if (!runCommand(installCmd.c_str())) {
        setStatus(L"❌ Ollama インストールに失敗しました");
        setProgress(L"");
        EnableWindow(hInstallBtn, TRUE);
        return 1;
    }

    // Give Ollama service time to start
    Sleep(3000);

    // Step 4: Pull default model
    setStatus(L"デフォルトモデルを取得中...");
    std::wstring pullCmd = L"ollama pull ";
    pullCmd += DEFAULT_MODEL;
    setProgress((std::wstring(L"[4/4] ollama pull ") + DEFAULT_MODEL).c_str());

    if (!runCommand(pullCmd.c_str())) {
        setStatus(L"⚠ モデル取得に失敗 — 手動で実行してください");
    }

    // Pull additional models
    for (size_t i = 0; i < additionalModels.size(); i++) {
        std::wostringstream oss;
        oss << L"追加モデル取得中: " << additionalModels[i]
            << L" (" << (i + 1) << L"/" << additionalModels.size() << L")";
        setStatus(oss.str().c_str());
        std::wstring cmd = L"ollama pull " + additionalModels[i];
        runCommand(cmd.c_str());
    }

    setStatus(L"✅ インストール完了！");
    setProgress(L"SAGBI AGI を開くにはボタンをクリック");
    installComplete = true;
    SetWindowTextW(hOpenHpBtn, L"🚀 SAGBI を起動");
    EnableWindow(hOpenHpBtn, TRUE);
    EnableWindow(hInstallBtn, TRUE);
    return 0;
}

// ── Window Procedure ─────────────────────────────────────────
LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_CREATE: {
        const DWORD sStyle = WS_VISIBLE | WS_CHILD;

        // Title
        CreateWindowW(L"STATIC", L"🤖 SAGBI AGI Installer",
            sStyle | SS_CENTER, 20, 15, 440, 30, hwnd, NULL, NULL, NULL);

        // Description
        CreateWindowW(L"STATIC",
            L"Ollama + gemma3 モデルを自動インストールします。\n"
            L"追加モデルがあれば下に入力してください。",
            sStyle, 20, 50, 440, 40, hwnd, NULL, NULL, NULL);

        // Model input
        CreateWindowW(L"STATIC", L"追加モデル名:",
            sStyle, 20, 100, 100, 25, hwnd, NULL, NULL, NULL);
        hModelEdit = CreateWindowW(L"EDIT", L"",
            sStyle | WS_BORDER | ES_AUTOHSCROLL,
            125, 98, 220, 25, hwnd, (HMENU)IDC_MODEL_EDIT, NULL, NULL);
        hAddModelBtn = CreateWindowW(L"BUTTON", L"追加",
            sStyle, 355, 97, 80, 27, hwnd, (HMENU)IDC_ADD_MODEL_BTN, NULL, NULL);

        // Model list
        hModelList = CreateWindowW(L"LISTBOX", L"",
            sStyle | WS_BORDER | LBS_NOINTEGRALHEIGHT,
            20, 130, 440, 70, hwnd, (HMENU)IDC_MODEL_LIST, NULL, NULL);
        SendMessageW(hModelList, LB_ADDSTRING, 0,
            (LPARAM)(std::wstring(L"[default] ") + DEFAULT_MODEL).c_str());

        // RAG Source Settings
        CreateWindowW(L"STATIC", L"RAGソース参照フォルダ:",
            sStyle, 20, 210, 150, 25, hwnd, NULL, NULL, NULL);
        hRagPathLabel = CreateWindowW(L"STATIC", selectedRagPath.c_str(),
            sStyle | SS_ENDELLIPSIS, 170, 210, 200, 25, hwnd, NULL, NULL, NULL);
        CreateWindowW(L"BUTTON", L"参照...",
            sStyle, 380, 207, 80, 25, hwnd, (HMENU)IDC_SELECT_RAG_BTN, NULL, NULL);

        // History Storage Settings
        CreateWindowW(L"STATIC", L"会話履歴の保存先:",
            sStyle, 20, 235, 150, 25, hwnd, NULL, NULL, NULL);
        hHistPathLabel = CreateWindowW(L"STATIC", selectedHistPath.c_str(),
            sStyle | SS_ENDELLIPSIS, 170, 235, 200, 25, hwnd, NULL, NULL, NULL);
        CreateWindowW(L"BUTTON", L"参照...",
            sStyle, 380, 232, 80, 25, hwnd, (HMENU)IDC_SELECT_HIST_BTN, NULL, NULL);

        // Status
        hStatus = CreateWindowW(L"STATIC", L"準備完了",
            sStyle, 20, 265, 440, 25, hwnd, (HMENU)IDC_STATUS_LABEL, NULL, NULL);
        hProgress = CreateWindowW(L"STATIC", L"",
            sStyle, 20, 285, 440, 25, hwnd, (HMENU)IDC_PROGRESS_LABEL, NULL, NULL);

        // Buttons
        hInstallBtn = CreateWindowW(L"BUTTON", L"📥 インストール開始",
            sStyle | BS_DEFPUSHBUTTON, 20, 320, 200, 35,
            hwnd, (HMENU)IDC_INSTALL_BTN, NULL, NULL);
        hOpenHpBtn = CreateWindowW(L"BUTTON", L"🌐 SAGBI AGI を開く",
            sStyle, 240, 320, 200, 35,
            hwnd, (HMENU)IDC_OPEN_HP_BTN, NULL, NULL);
        EnableWindow(hOpenHpBtn, FALSE);

        CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
        break;
    }

    case WM_COMMAND:
        switch (LOWORD(wParam)) {
        case IDC_ADD_MODEL_BTN: {
            wchar_t buf[256];
            GetWindowTextW(hModelEdit, buf, 256);
            std::wstring model(buf);
            if (!model.empty()) {
                additionalModels.push_back(model);
                SendMessageW(hModelList, LB_ADDSTRING, 0,
                    (LPARAM)(L"[追加] " + model).c_str());
                SetWindowTextW(hModelEdit, L"");
            }
            break;
        }
        case IDC_SELECT_RAG_BTN: {
            BROWSEINFOW bi = { 0 };
            bi.lpszTitle = L"RAGソース参照ファイルを保存するフォルダを選択してください";
            bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
            bi.hwndOwner = hwnd;
            LPITEMIDLIST pidl = SHBrowseForFolderW(&bi);
            if (pidl != 0) {
                wchar_t path[MAX_PATH];
                if (SHGetPathFromIDListW(pidl, path)) {
                    selectedRagPath = path;
                    SetWindowTextW(hRagPathLabel, path);
                    
                    // ユーザーへの警告
                    MessageBoxW(hwnd, 
                        L"ここが以降の参照フォルダになります。\n個人情報などは保存しないで下さい。", 
                        L"RAG設定の警告", MB_OK | MB_ICONWARNING);
                }
                CoTaskMemFree(pidl);
            }
            break;
        }
        case IDC_SELECT_HIST_BTN: {
            BROWSEINFOW bi = { 0 };
            bi.lpszTitle = L"会話履歴を保存するフォルダを選択してください（プロジェクト外を推奨）";
            bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
            bi.hwndOwner = hwnd;
            LPITEMIDLIST pidl = SHBrowseForFolderW(&bi);
            if (pidl != 0) {
                wchar_t path[MAX_PATH];
                if (SHGetPathFromIDListW(pidl, path)) {
                    selectedHistPath = path;
                    SetWindowTextW(hHistPathLabel, path);
                    MessageBoxW(hwnd, L"履歴の保存先を設定しました。ここには個人情報が含まれる可能性があるため、公開されないよう注意してください。", L"履歴設定", MB_OK);
                }
                CoTaskMemFree(pidl);
            }
            break;
        }
        case IDC_INSTALL_BTN:
            EnableWindow(hInstallBtn, FALSE);
            CreateThread(NULL, 0, installWorker, hwnd, 0, NULL);
            break;
        case IDC_OPEN_HP_BTN:
            // 単にURLを開くのではなく、生成したバッチファイルを叩いてサーバーごと起動する
            ShellExecuteW(NULL, L"open", L"run_sagbi.bat", NULL, NULL, SW_SHOWNORMAL);
            break;
        }
        break;

    case WM_DESTROY:
        CoUninitialize();
        PostQuitMessage(0);
        break;

    default:
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    return 0;
}

// ── Entry Point ──────────────────────────────────────────────
int APIENTRY WinMain(HINSTANCE hInst, HINSTANCE, LPSTR, int nShow) {
    WNDCLASSW wc = {};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = L"SAGBIInstaller";
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);

    if (!RegisterClassW(&wc)) {
        MessageBoxW(NULL, L"ウィンドウクラス登録に失敗", WINDOW_TITLE, MB_ICONERROR);
        return 1;
    }

    HWND hwnd = CreateWindowExW(
        0, L"SAGBIInstaller", WINDOW_TITLE,
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE,
        CW_USEDEFAULT, CW_USEDEFAULT, 500, 350,
        NULL, NULL, hInst, NULL);

    if (!hwnd) {
        MessageBoxW(NULL, L"ウィンドウ作成に失敗", WINDOW_TITLE, MB_ICONERROR);
        return 1;
    }

    MSG msg = {};
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return 0;
}
