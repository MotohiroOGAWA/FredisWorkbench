#include "json_support.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>

namespace viewer {

void emit(const json& message) {
  std::string line = message.dump(-1, ' ', false, json::error_handler_t::replace);
  std::cout << kPrefix << line << '\n';
  std::cout.flush();
}

json to_json(const Value& value) {
  if (const auto* b = std::get_if<bool>(&value)) return *b;
  if (const auto* i = std::get_if<int64_t>(&value)) return *i;
  if (const auto* d = std::get_if<double>(&value)) {
    if (!std::isfinite(*d)) return nullptr;
    return *d;
  }
  if (const auto* s = std::get_if<std::string>(&value)) return *s;
  return nullptr;
}

namespace {

template <typename ArrayType>
Value integer_at(const arrow::Array& array, int64_t i) {
  return static_cast<int64_t>(static_cast<const ArrayType&>(array).Value(i));
}

Value value_at(const arrow::Array& array, int64_t i) {
  if (array.IsNull(i)) return std::monostate{};
  switch (array.type_id()) {
    case arrow::Type::BOOL:
      return static_cast<const arrow::BooleanArray&>(array).Value(i);
    case arrow::Type::INT8: return integer_at<arrow::Int8Array>(array, i);
    case arrow::Type::INT16: return integer_at<arrow::Int16Array>(array, i);
    case arrow::Type::INT32: return integer_at<arrow::Int32Array>(array, i);
    case arrow::Type::INT64: return integer_at<arrow::Int64Array>(array, i);
    case arrow::Type::UINT8: return integer_at<arrow::UInt8Array>(array, i);
    case arrow::Type::UINT16: return integer_at<arrow::UInt16Array>(array, i);
    case arrow::Type::UINT32: return integer_at<arrow::UInt32Array>(array, i);
    case arrow::Type::UINT64: return integer_at<arrow::UInt64Array>(array, i);
    case arrow::Type::FLOAT:
      return static_cast<double>(static_cast<const arrow::FloatArray&>(array).Value(i));
    case arrow::Type::DOUBLE:
      return static_cast<const arrow::DoubleArray&>(array).Value(i);
    case arrow::Type::STRING:
      return static_cast<const arrow::StringArray&>(array).GetString(i);
    case arrow::Type::LARGE_STRING:
      return static_cast<const arrow::LargeStringArray&>(array).GetString(i);
    case arrow::Type::NA:
      return std::monostate{};
    default: {
      auto scalar = array.GetScalar(i);
      return scalar.ok() ? Value(scalar.ValueOrDie()->ToString()) : Value(std::monostate{});
    }
  }
}

}  // namespace

std::vector<Value> array_values(const arrow::ChunkedArray& column) {
  std::vector<Value> values;
  values.reserve(static_cast<std::size_t>(column.length()));
  for (const auto& chunk : column.chunks()) {
    for (int64_t i = 0; i < chunk->length(); ++i) values.push_back(value_at(*chunk, i));
  }
  return values;
}

std::string display_text(const Value& value) { return msentity::to_display_string(value); }

std::optional<double> parse_number(const std::string& text) {
  std::size_t begin = text.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) return std::nullopt;
  std::size_t end = text.find_last_not_of(" \t\r\n");
  std::string trimmed = text.substr(begin, end - begin + 1);
  char* stop = nullptr;
  double number = std::strtod(trimmed.c_str(), &stop);
  if (stop != trimmed.c_str() + trimmed.size()) return std::nullopt;
  return number;
}

std::optional<double> numeric_value(const Value& value) {
  if (const auto* d = std::get_if<double>(&value)) {
    if (std::isnan(*d)) return std::nullopt;
    return *d;
  }
  if (const auto* i = std::get_if<int64_t>(&value)) return static_cast<double>(*i);
  if (const auto* b = std::get_if<bool>(&value)) return *b ? 1.0 : 0.0;
  if (const auto* s = std::get_if<std::string>(&value)) {
    auto number = parse_number(*s);
    if (number && std::isnan(*number)) return std::nullopt;
    return number;
  }
  return std::nullopt;
}

std::string json_text(const json& value) {
  if (value.is_null()) return "";
  if (value.is_string()) return value.get<std::string>();
  if (value.is_boolean()) return value.get<bool>() ? "True" : "False";
  if (value.is_number_integer()) return std::to_string(value.get<int64_t>());
  if (value.is_number_float()) return msentity::format_float(value.get<double>());
  return value.dump();
}

std::string fold_case(std::string text) {
  for (char& c : text) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return text;
}

json spectrum_json(const msentity::Spectrum& spectrum) {
  json mz = json::array();
  json intensity = json::array();
  for (int64_t i = 0; i < spectrum.size(); ++i) {
    double m = spectrum.mz(i);
    double y = spectrum.intensity(i);
    mz.push_back(std::isfinite(m) ? json(m) : json(nullptr));
    intensity.push_back(std::isfinite(y) ? json(y) : json(nullptr));
  }
  json columns = json::array();
  json rows = json::array();
  auto table = spectrum.metadata();
  if (table) {
    std::vector<std::vector<Value>> values;
    for (const auto& name : spectrum.metadata_columns()) {
      auto column = table->GetColumnByName(name);
      if (!column) continue;
      columns.push_back(name);
      values.push_back(array_values(*column));
    }
    for (int64_t r = 0; r < table->num_rows(); ++r) {
      json row = json::object();
      for (std::size_t c = 0; c < values.size(); ++c) {
        row[columns[c].get<std::string>()] = to_json(values[c][static_cast<std::size_t>(r)]);
      }
      rows.push_back(std::move(row));
    }
  }
  return {{"mz", mz}, {"intensity", intensity}, {"metadata_columns", columns}, {"metadata", rows}};
}

bool is_missing(const Value& value) {
  if (msentity::is_null(value)) return true;
  const auto* d = std::get_if<double>(&value);
  return d != nullptr && std::isnan(*d);
}

int compare_values(const Value& a, const Value& b) {
  auto number = [](const Value& v) -> std::optional<double> {
    if (const auto* d = std::get_if<double>(&v)) return *d;
    if (const auto* i = std::get_if<int64_t>(&v)) return static_cast<double>(*i);
    if (const auto* x = std::get_if<bool>(&v)) return *x ? 1.0 : 0.0;
    return std::nullopt;
  };
  auto x = number(a);
  auto y = number(b);
  if (x && y) return *x < *y ? -1 : (*x > *y ? 1 : 0);
  if (x) return -1;  // numbers before text
  if (y) return 1;
  const auto& s = std::get<std::string>(a);
  const auto& t = std::get<std::string>(b);
  return s < t ? -1 : (s > t ? 1 : 0);
}

std::optional<std::string> detect_smiles_column(const std::vector<std::string>& columns,
                                                const std::string& preferred) {
  auto find = [&](const std::string& folded) -> std::optional<std::string> {
    for (const auto& column : columns) {
      if (fold_case(column) == folded) return column;
    }
    return std::nullopt;
  };
  std::string wanted = fold_case(preferred);
  wanted.erase(0, wanted.find_first_not_of(" \t"));
  wanted.erase(wanted.find_last_not_of(" \t") + 1);
  if (!wanted.empty()) {
    if (auto column = find(wanted)) return column;
  }
  for (const char* name : {"smiles", "canonical_smiles", "isomeric_smiles"}) {
    if (auto column = find(name)) return column;
  }
  return std::nullopt;
}

}  // namespace viewer
