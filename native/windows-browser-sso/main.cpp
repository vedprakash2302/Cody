// Windows owns the account and device keys. This process only requests the
// per-navigation proof, returning it through Electron's private stdout pipe.
#include <windows.h>
#include <proofofpossessioncookieinfo.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static bool allowed_uri(const wchar_t* uri) {
    const wchar_t* origin = L"https://login.microsoftonline.com";
    const size_t length = wcslen(origin);
    return _wcsnicmp(uri, origin, length) == 0 &&
        (uri[length] == L'/' || uri[length] == L'?' || uri[length] == L'\0');
}

static bool ascii(const wchar_t* value) {
    if (!value) return false;
    for (; *value; ++value) if (*value < 0x20 || *value > 0x7e) return false;
    return true;
}

static void json_string(const wchar_t* value) {
    putchar('"');
    for (; *value; ++value) {
        if (*value == L'"' || *value == L'\\') putchar('\\');
        putchar(static_cast<char>(*value));
    }
    putchar('"');
}

int main(int argc, char**) {
    if (argc != 1) return 1;
    char input[32769];
    wchar_t uri[32769];
    if (!fgets(input, sizeof(input), stdin)) return 1;
    size_t length = strlen(input);
    if (!length || input[length - 1] != '\n') return 1;
    input[--length] = '\0';
    if (length && input[length - 1] == '\r') input[--length] = '\0';
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, uri, 32769) ||
        !allowed_uri(uri)) return 1;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) return 1;
    IProofOfPossessionCookieInfoManager* manager = nullptr;
    const CLSID clsid = {0xa9927f85, 0xa304, 0x4390, {0x8b, 0x23, 0xa7, 0x5f, 0x1c, 0x66, 0x86, 0x00}};
    hr = CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&manager));
    DWORD count = 0;
    ProofOfPossessionCookieInfo* cookies = nullptr;
    if (SUCCEEDED(hr)) hr = manager->GetCookieInfoForUri(uri, &count, &cookies);
    bool valid = SUCCEEDED(hr) && count <= 32 && (!count || cookies);
    for (DWORD i = 0; valid && i < count; ++i)
        valid = ascii(cookies[i].name) && ascii(cookies[i].data);

    if (valid) {
        fputs("{\"ok\":true,\"cookies\":[", stdout);
        for (DWORD i = 0; i < count; ++i) {
            if (i) putchar(',');
            fputs("{\"name\":", stdout);
            json_string(cookies[i].name);
            fputs(",\"data\":", stdout);
            json_string(cookies[i].data);
            putchar('}');
        }
        fputs("]}\n", stdout);
    } else {
        // Never print exception text, URLs, or partially fetched credentials.
        printf("{\"ok\":false,\"code\":\"0x%08lx\"}\n", static_cast<unsigned long>(hr));
    }
    if (cookies) FreeProofOfPossessionCookieInfoArray(cookies, count);
    if (manager) manager->Release();
    CoUninitialize();
    return valid ? 0 : 1;
}
