#pragma once

#include <optional>
#include <string>

namespace viewer {

// Serve requests for a dataset viewer opened on `path` (protocol: docs/protocol.md).
int run_dataset_backend(const std::string& path, int page_size,
                        const std::optional<std::string>& file_type);

// Serve requests for a similarity result viewer opened on an .mssim file.
int run_similarity_backend(const std::string& path, int page_size);

}  // namespace viewer
