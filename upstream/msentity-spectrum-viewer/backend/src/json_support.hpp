// JSON conversion and output shared by the dataset and similarity backends.
#pragma once

#include <arrow/api.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <msentity/msentity.hpp>

namespace viewer {

using json = nlohmann::ordered_json;
using msentity::MSDataset;
using msentity::Value;

// Every protocol line written to stdout starts with this prefix; other lines
// are logged by the host.
inline constexpr const char* kPrefix = "MSENTITY_JSON:";

// Write one protocol message (one line) and flush.
void emit(const json& message);

// A cell as JSON: null for missing values, NaN, and infinities.
json to_json(const Value& value);

// Values of an Arrow column (null, bool, integers, floats, strings).
std::vector<Value> array_values(const arrow::ChunkedArray& column);

// Text of a cell for text filters: "" for missing values, "True"/"False",
// "250", "20.0" (msentity::to_display_string).
std::string display_text(const Value& value);

// Number of a cell for numeric comparison: numbers, booleans (1/0), and
// numeric text; nullopt otherwise.
std::optional<double> numeric_value(const Value& value);

// Number from text; nullopt unless the whole text is a number.
std::optional<double> parse_number(const std::string& text);

// Text of a JSON scalar sent by the UI ("" for null).
std::string json_text(const json& value);

// Lower-case ASCII letters (case-insensitive matching of names and text).
std::string fold_case(std::string text);

// The peaks and peak metadata of one spectrum:
// {"mz": [...], "intensity": [...], "metadata_columns": [...], "metadata": [{...}, ...]}
json spectrum_json(const msentity::Spectrum& spectrum);

// Order of two cells for sorting: numbers by value, text by code point,
// numbers before text. Missing values are handled by the caller.
int compare_values(const Value& a, const Value& b);
bool is_missing(const Value& value);

// Column holding SMILES: `preferred` (case-insensitive), else smiles,
// canonical_smiles, isomeric_smiles.
std::optional<std::string> detect_smiles_column(const std::vector<std::string>& columns,
                                                const std::string& preferred);

}  // namespace viewer
