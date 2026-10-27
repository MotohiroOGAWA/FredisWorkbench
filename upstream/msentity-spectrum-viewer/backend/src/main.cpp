// msentity-viewer-backend: serves the viewer UI over stdin/stdout.
//
//   msentity-viewer-backend dataset <file> [--page-size N] [--file-type msds|msp|mgf|tsv|csv]
//   msentity-viewer-backend similarity <file.mssim> [--page-size N]
//   msentity-viewer-backend --version
//
// Requests are JSON objects, one per line, on stdin. Responses are lines on
// stdout starting with "MSENTITY_JSON:"; diagnostics go to stderr.
// The protocol is described in docs/protocol.md.

#include <iostream>
#include <optional>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

#include "backends.hpp"

namespace {

int usage() {
  std::cerr << "usage:\n"
               "  msentity-viewer-backend dataset <file> [--page-size N] [--file-type T]\n"
               "  msentity-viewer-backend similarity <file.mssim> [--page-size N]\n"
               "  msentity-viewer-backend --version\n";
  return 2;
}

int run(const std::vector<std::string>& args) {
  if (args.size() == 1 && args[0] == "--version") {
    std::cout << MSENTITY_VIEWER_VERSION << "\n";
    return 0;
  }
  if (args.size() < 2) return usage();
  const std::string& mode = args[0];
  std::string path = args[1];
  std::optional<int> page_size;
  std::optional<std::string> file_type;
  for (std::size_t i = 2; i < args.size(); ++i) {
    if (args[i] == "--page-size" && i + 1 < args.size()) {
      try {
        page_size = std::stoi(args[++i]);
      } catch (const std::exception&) {
        return usage();
      }
    } else if (args[i] == "--file-type" && i + 1 < args.size()) {
      file_type = args[++i];
    } else {
      return usage();
    }
  }
  if (mode == "dataset") return viewer::run_dataset_backend(path, page_size.value_or(20), file_type);
  if (mode == "similarity") return viewer::run_similarity_backend(path, page_size.value_or(50));
  return usage();
}

}  // namespace

#if defined(_WIN32)
// Arguments as UTF-8; stdin/stdout without newline translation.
int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  std::vector<std::string> args;
  for (int i = 1; i < argc; ++i) {
    int size = WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, nullptr, 0, nullptr, nullptr);
    std::string text(static_cast<std::size_t>(size > 0 ? size - 1 : 0), '\0');
    WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, text.data(), size, nullptr, nullptr);
    args.push_back(text);
  }
  return run(args);
}
#else
int main(int argc, char** argv) { return run(std::vector<std::string>(argv + 1, argv + argc)); }
#endif
