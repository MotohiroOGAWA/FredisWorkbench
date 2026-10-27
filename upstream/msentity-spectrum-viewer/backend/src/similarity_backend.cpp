// Similarity result viewer backend: pages, histogram, statistics, matched
// spectra, and export of a filtered .mssim result.

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iostream>

#include <msentity/similarity/similarity.hpp>

#include "backends.hpp"
#include "json_support.hpp"
#include "view.hpp"

namespace viewer {

namespace fs = std::filesystem;
namespace sim = msentity::similarity;

namespace {

std::string utf8(const fs::path& path) {
  auto text = path.u8string();
  return std::string(text.begin(), text.end());
}

fs::path from_utf8(const std::string& text) {
  return fs::path(std::u8string(text.begin(), text.end()));
}

json finite(double value) { return std::isfinite(value) ? json(value) : json(nullptr); }

class SimilarityBackend {
 public:
  SimilarityBackend(std::string path, int page_size) : path_(std::move(path)), page_size_(page_size) {}

  int run() {
    try {
      load();
    } catch (const std::exception& error) {
      emit({{"type", "error"}, {"message", error.what()}});
      return 1;
    }
    emit({{"type", "backend-ready"}});
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.find_first_not_of(" \t") == std::string::npos) continue;
      try {
        json request = json::parse(line);
        std::string kind = json_text(request.value("type", json()));
        if (kind == "reload") load();
        if (kind == "page" || kind == "reload") {
          emit({{"type", "similarity-page"}, {"value", page(request)}});
        } else if (kind == "match") {
          json payload = match(request.at("row").get<int64_t>());
          payload["type"] = "similarity-match";
          emit(payload);
        } else if (kind == "export") {
          int64_t count = export_result(request);
          emit({{"type", "export-complete"}, {"path", request.at("path")}, {"total_rows", count}});
        } else {
          throw std::invalid_argument("Unknown request: " + kind);
        }
      } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        emit({{"type", "error"}, {"message", error.what()}});
      }
    }
    return 0;
  }

 private:
  std::string path_;
  int page_size_;
  std::optional<sim::SimilarityDataset> result_;
  json metadata_;

  void load() {
    result_ = sim::SimilarityDataset::load(path_);
    metadata_ = json::parse(result_->metadata_json());
  }

  std::vector<int64_t> rows(const json& request) const {
    const auto& result = *result_;
    return table_view_rows(
        result.size(), result.columns(),
        [&](const std::string& column) { return result.column_values(column); },
        request.value("filters", json::array()), request.value("sort", json()));
  }

  // The rows of the result in view order, as a SimilarityDataset (for export).
  sim::SimilarityDataset view_of(const std::vector<int64_t>& order) const {
    const auto& result = *result_;
    std::vector<bool> keep(static_cast<std::size_t>(result.size()), false);
    for (int64_t row : order) keep[static_cast<std::size_t>(row)] = true;
    if (std::is_sorted(order.begin(), order.end())) return result.filter(keep);
    // filter() keeps table order: add each row's rank in the view as a
    // temporary column, filter, sort by it, and drop it.
    std::vector<int64_t> rank(static_cast<std::size_t>(result.size()), 0);
    for (std::size_t i = 0; i < order.size(); ++i) {
      rank[static_cast<std::size_t>(order[i])] = static_cast<int64_t>(i);
    }
    arrow::Int64Builder builder;
    if (!builder.AppendValues(rank).ok()) throw std::runtime_error("cannot build view order");
    auto table = result.table();
    auto with_rank = table->AddColumn(table->num_columns(), arrow::field("__view_rank", arrow::int64()),
                                      std::make_shared<arrow::ChunkedArray>(builder.Finish().ValueOrDie()))
                         .ValueOrDie();
    sim::SimilarityDataset ranked(with_rank, result.metadata_json(), result.matched_datasets(),
                                  result.matched_source_indices());
    sim::SimilarityDataset ordered = ranked.filter(keep).sort_by({"__view_rank"}, {true});
    auto ordered_table = ordered.table();
    auto clean = ordered_table->RemoveColumn(ordered_table->schema()->GetFieldIndex("__view_rank")).ValueOrDie();
    return sim::SimilarityDataset(clean, ordered.metadata_json(), ordered.matched_datasets(),
                                  ordered.matched_source_indices());
  }

  json page(const json& request) const {
    const auto& result = *result_;
    std::vector<int64_t> order = rows(request);
    int bins = request.value("bins", json(20)).get<int>();
    if (bins < 1 || bins > 200) throw std::invalid_argument("Histogram bins must be between 1 and 200");

    // Statistics and histogram of the filtered rows.
    std::vector<bool> keep(static_cast<std::size_t>(result.size()), false);
    for (int64_t row : order) keep[static_cast<std::size_t>(row)] = true;
    sim::SimilarityDataset filtered = result.filter(keep);
    auto histogram = filtered.histogram(bins);
    auto summary = filtered.describe_scores();

    int64_t total = static_cast<int64_t>(order.size());
    int64_t pages = std::max<int64_t>(1, (total + page_size_ - 1) / page_size_);
    int64_t page = std::min(std::max<int64_t>(0, request.value("page", json(0)).get<int64_t>()), pages - 1);
    int64_t start = page * page_size_;
    int64_t stop = std::min(start + page_size_, total);

    const auto columns = result.columns();
    std::vector<std::vector<Value>> values;
    for (const auto& column : columns) values.push_back(result.column_values(column));
    json page_rows = json::array();
    json indices = json::array();
    for (int64_t i = start; i < stop; ++i) {
      int64_t row = order[static_cast<std::size_t>(i)];
      json item = json::object();
      for (std::size_t c = 0; c < columns.size(); ++c) {
        item[columns[c]] = to_json(values[c][static_cast<std::size_t>(row)]);
      }
      page_rows.push_back(std::move(item));
      indices.push_back(row);
    }
    json edges = json::array();
    for (double edge : histogram.edges) edges.push_back(finite(edge));
    json matched_rows = json::array({0, 0});
    if (result.has_matched_data()) {
      matched_rows = {result.matched_datasets()->first.size(), result.matched_datasets()->second.size()};
    }
    return {{"columns", columns},
            {"rows", page_rows},
            {"result_indices", indices},
            {"page", page},
            {"total_pages", pages},
            {"page_size", page_size_},
            {"total_rows", total},
            {"unfiltered_rows", result.size()},
            {"metadata", metadata_},
            {"has_matched_data", result.has_matched_data()},
            {"matched_data_rows", matched_rows},
            {"histogram", {{"counts", histogram.counts}, {"edges", edges}}},
            {"statistics", {{"mean", finite(summary.mean)}, {"q1", finite(summary.q1)},
                            {"median", finite(summary.median)}, {"q3", finite(summary.q3)},
                            {"min", finite(summary.min)}, {"max", finite(summary.max)}}}};
  }

  json match(int64_t row) const {
    const auto& result = *result_;
    if (!result.has_matched_data()) {
      throw std::invalid_argument("This similarity result does not contain matched data");
    }
    if (row < 0 || row >= result.size()) throw std::out_of_range("row out of range");
    auto [first, second] = result.match_records(row);
    json sources = metadata_.value("sources", json::array());
    if (!sources.is_array()) sources = json::array();
    json payloads = json::array();
    int side = 0;
    for (const MSDataset* record : {&first, &second}) {
      std::string data_column = "data_index" + std::to_string(side + 1);
      int64_t data_index = std::get<int64_t>(result.column_values(data_column)[static_cast<std::size_t>(row)]);
      const auto& source_indices = side == 0 ? result.matched_source_indices()->first
                                             : result.matched_source_indices()->second;
      int64_t source_index = source_indices[static_cast<std::size_t>(data_index)];
      json source = side < static_cast<int>(sources.size()) && sources[side].is_object()
                        ? sources[side] : json::object();
      json metadata = json::object();
      std::string title;
      for (const auto& column : record->columns()) metadata[column] = to_json(record->value(0, column));
      for (const char* key : {"Name", "name", "TITLE", "Title", "SpecID", "ID", "id"}) {
        if (metadata.contains(key) && !metadata[key].is_null() && json_text(metadata[key]) != "") {
          title = json_text(metadata[key]);
          break;
        }
      }
      if (title.empty()) title = "Spectrum " + std::to_string(source_index + 1);
      std::string source_path = json_text(source.value("path", json("")));
      std::string name = utf8(from_utf8(source_path).filename());
      if (name.empty()) {
        name = source.contains("role") ? json_text(source["role"]) : "Dataset " + std::to_string(side + 1);
      }
      payloads.push_back({{"datasetName", name},
                          {"datasetPath", source_path},
                          {"globalIndex", source_index},
                          {"title", title},
                          {"columns", record->columns()},
                          {"row", metadata},
                          {"spectrum", spectrum_json(record->peaks().spectrum(0))}});
      ++side;
    }
    json parameters = metadata_.value("parameters", json::object());
    return {{"query", payloads[0]},
            {"reference", payloads[1]},
            {"method", parameters.is_object() ? parameters.value("method", json("cosine")) : json("cosine")}};
  }

  int64_t export_result(const json& request) const {
    std::vector<int64_t> order = rows(request);
    sim::SimilarityDataset view = view_of(order);
    fs::path path = from_utf8(json_text(request.at("path")));
    std::string suffix = fold_case(utf8(path.extension()));
    if (suffix == ".mssim") {
      json metadata = json::parse(view.metadata_json());
      metadata["row_count"] = view.size();
      metadata["export_view"] = {{"filters", request.value("filters", json::array())},
                                 {"sort", request.value("sort", json())},
                                 {"source_rows", result_->size()}};
      view.set_metadata_json(metadata.dump());
      view.save(utf8(path));
    } else if (suffix == ".parquet" || suffix == ".csv" || suffix == ".tsv") {
      view.export_table(utf8(path));
    } else {
      throw std::invalid_argument("Export format must be mssim, parquet, csv, or tsv");
    }
    return view.size();
  }
};

}  // namespace

int run_similarity_backend(const std::string& path, int page_size) {
  SimilarityBackend backend(path, std::max(1, page_size));
  return backend.run();
}

}  // namespace viewer
