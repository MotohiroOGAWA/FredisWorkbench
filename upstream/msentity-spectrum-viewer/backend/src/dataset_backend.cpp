// Dataset viewer backend: one process per viewer, holding every dataset the
// viewer has loaded (the opened file plus "Add dataset" entries).

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <map>
#include <random>
#include <set>

#include <msentity/similarity/similarity.hpp>

#include "backends.hpp"
#include "json_support.hpp"
#include "view.hpp"

namespace viewer {

namespace fs = std::filesystem;

namespace {

std::string utf8(const fs::path& path) {
  auto text = path.u8string();
  return std::string(text.begin(), text.end());
}

fs::path from_utf8(const std::string& text) {
  return fs::path(std::u8string(text.begin(), text.end()));
}

fs::path resolve(const std::string& text) {
  fs::path path = from_utf8(text);
  if (!text.empty() && text[0] == '~') {
    if (const char* home = std::getenv("HOME")) path = from_utf8(home) / from_utf8(text.substr(text.size() > 1 ? 2 : 1));
  }
  std::error_code error;
  fs::path absolute = fs::absolute(path, error);
  fs::path canonical = fs::weakly_canonical(absolute, error);
  return error ? absolute : canonical;
}

std::string lower_extension(const fs::path& path) {
  std::string extension = utf8(path.extension());
  if (!extension.empty() && extension[0] == '.') extension.erase(0, 1);
  return fold_case(extension);
}

// Emits progress messages only when the whole percentage changes.
class Throttle {
 public:
  bool due(double percent, bool final) {
    int whole = static_cast<int>(percent);
    if (whole == last_ && !final) return false;
    last_ = whole;
    return true;
  }

 private:
  int last_ = -1;
};

MSDataset load_dataset(const fs::path& path, const std::optional<std::string>& file_type) {
  std::string type = file_type ? fold_case(*file_type) : lower_extension(path);
  msentity::io::ReadProgressCallback progress;
  Throttle throttle;
  if (type == "msp" || type == "mgf") {
    auto size = static_cast<int64_t>(fs::file_size(path));
    emit({{"type", "loading-progress"}, {"file_type", type}, {"processed", 0}, {"total", size},
          {"success", 0}, {"records", 0}, {"percent", 0.0}});
    progress = [type, &throttle](int64_t processed, int64_t total, int64_t success, int64_t records) {
      double percent = total > 0 ? std::min(100.0, processed * 100.0 / total) : 0.0;
      if (!throttle.due(percent, processed >= total)) return;
      emit({{"type", "loading-progress"}, {"file_type", type}, {"processed", processed},
            {"total", total}, {"success", success}, {"records", records}, {"percent", percent}});
    };
  }
  return msentity::io::load_ms_dataset(utf8(path), type, std::nullopt, progress, false);
}

struct Entry {
  MSDataset dataset;
  fs::path path;
  std::optional<std::string> file_type;
  std::string name;
};

json attributes_json(const MSDataset& dataset) {
  json out = json::object();
  for (const auto& [key, value] : dataset.attributes()) out[key] = value;
  return out;
}

// Position of the spectrum with storage row id `row_id` in `dataset`.
int64_t position_of(const MSDataset& dataset, const json& row_id) {
  if (!row_id.is_number_integer()) throw std::invalid_argument("Unknown spectrum");
  const auto& index = dataset.peaks().index();
  auto found = std::find(index.begin(), index.end(), row_id.get<int64_t>());
  if (found == index.end()) throw std::invalid_argument("Unknown spectrum");
  return found - index.begin();
}

// New value for an edited cell, keeping the type of the old one.
Value edited_value(const Value& old_value, const std::string& text, bool allow_other_types) {
  if (std::holds_alternative<bool>(old_value)) {
    if (text != "true" && text != "false") throw std::invalid_argument("Enter true or false");
    return text == "true";
  }
  if (std::holds_alternative<int64_t>(old_value) || std::holds_alternative<double>(old_value)) {
    std::string digits = text;
    digits.erase(0, digits.find_first_not_of("+-"));
    bool integer = std::holds_alternative<int64_t>(old_value) && !digits.empty() &&
                   std::all_of(digits.begin(), digits.end(), [](char c) { return c >= '0' && c <= '9'; });
    if (integer) return static_cast<int64_t>(std::stoll(text));
    auto number = parse_number(text);
    if (!number) throw std::invalid_argument("could not convert string to float: '" + text + "'");
    if (!std::isfinite(*number)) throw std::invalid_argument("Enter a finite number");
    return *number;
  }
  if (!allow_other_types && !msentity::is_null(old_value) &&
      !std::holds_alternative<std::string>(old_value)) {
    throw std::invalid_argument("Only text, numeric and boolean cells can be edited");
  }
  return text;
}

class DatasetBackend {
 public:
  DatasetBackend(int page_size) : page_size_(page_size) {}

  int run(const fs::path& input, const std::optional<std::string>& file_type) {
    if (!fs::is_regular_file(input)) {
      emit({{"type", "error"}, {"title", "File not found"}, {"message", utf8(input)}});
      return 2;
    }
    MSDataset dataset;
    try {
      dataset = load_dataset(input, file_type);
    } catch (const std::exception& error) {
      std::cerr << error.what() << std::endl;
      emit({{"type", "error"}, {"title", "Could not load dataset"}, {"message", error.what()}});
      return 1;
    }
    initial_id_ = utf8(input);
    add_entry(initial_id_, Entry{dataset, input, file_type, utf8(input.filename())});
    emit({{"type", "backend-ready"}, {"file", initial_id_}, {"total_rows", dataset.size()},
          {"page_size", page_size_},
          {"dataset", {{"id", initial_id_}, {"name", utf8(input.filename())},
                       {"path", initial_id_}, {"total_rows", dataset.size()}}}});

    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.find_first_not_of(" \t") == std::string::npos) continue;
      try {
        handle(json::parse(line));
      } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        emit({{"type", "error"}, {"title", "Backend error"}, {"message", error.what()}});
      }
    }
    return 0;
  }

 private:
  int page_size_;
  std::string initial_id_;
  std::vector<std::string> order_;
  std::map<std::string, Entry> entries_;
  std::set<std::string> used_ids_;
  std::string structure_column_ = "SMILES";
  bool show_structure_column_ = true;

  void add_entry(const std::string& id, Entry entry) {
    order_.push_back(id);
    used_ids_.insert(id);
    entries_.emplace(id, std::move(entry));
  }

  Entry& entry(const std::string& id) {
    auto found = entries_.find(id);
    if (found == entries_.end()) throw std::invalid_argument("Unknown dataset: " + id);
    return found->second;
  }

  json page_json(const MSDataset& view, int64_t page, const std::string& id, const Entry& source) {
    int64_t total_rows = view.size();
    int64_t total_pages = std::max<int64_t>(1, (total_rows + page_size_ - 1) / page_size_);
    page = std::min(std::max<int64_t>(0, page), total_pages - 1);
    int64_t start = page * page_size_;
    int64_t stop = std::min(start + page_size_, total_rows);
    MSDataset page_view = view.slice(start, stop);

    std::vector<std::vector<Value>> columns;
    for (const auto& column : page_view.columns()) columns.push_back(page_view.column_values(column));
    json rows = json::array();
    json spectra = json::array();
    for (int64_t r = 0; r < page_view.size(); ++r) {
      json row = json::object();
      for (std::size_t c = 0; c < columns.size(); ++c) {
        row[page_view.columns()[c]] = to_json(columns[c][static_cast<std::size_t>(r)]);
      }
      rows.push_back(std::move(row));
      json spectrum = {{"index", start + r}};
      spectrum.update(spectrum_json(page_view.peaks().spectrum(r)));
      spectra.push_back(std::move(spectrum));
    }
    auto smiles = detect_smiles_column(view.columns(), structure_column_);
    return {{"dataset_id", id},
            {"dataset_name", source.name},
            {"dataset_path", utf8(source.path)},
            {"columns", page_view.columns()},
            {"rows", rows},
            {"row_ids", page_view.peaks().index()},
            {"spectra", spectra},
            {"page", page},
            {"page_size", page_size_},
            {"total_rows", total_rows},
            {"total_pages", total_pages},
            {"row_offset", start},
            {"structure_smiles_column", smiles ? json(*smiles) : json(nullptr)},
            {"show_structure_column", show_structure_column_},
            {"description", view.description()},
            {"attributes", attributes_json(view)},
            {"tags", view.tags()},
            {"all_columns", source.dataset.columns()}};
  }

  // Emits dataset-page, or filter-error when a filter is invalid.
  void send_page(const std::string& id, const json& request, int64_t page) {
    Entry& source = entry(id);
    MSDataset view;
    try {
      view = apply_dataset_view(source.dataset, request.value("filters", json()),
                                request.value("sort", json()));
    } catch (const std::invalid_argument& error) {  // FilterError, bad values
      emit({{"type", "filter-error"}, {"message", error.what()}});
      return;
    } catch (const msentity::KeyError& error) {
      emit({{"type", "filter-error"}, {"message", error.what()}});
      return;
    }
    emit({{"type", "dataset-page"}, {"value", page_json(view, page, id, source)}});
  }

  void handle(const json& request) {
    std::string type = json_text(request.value("type", json()));
    if (request.contains("structure_smiles_column") && request["structure_smiles_column"].is_string()) {
      std::string column = request["structure_smiles_column"].get<std::string>();
      if (column.find_first_not_of(" \t") != std::string::npos) structure_column_ = column;
    }
    if (request.contains("show_structure_column") && request["show_structure_column"].is_boolean()) {
      show_structure_column_ = request["show_structure_column"].get<bool>();
    }
    std::string id = json_text(request.value("dataset_id", json()));
    if (id.empty()) id = initial_id_;

    if (type == "page") {
      json page = request.value("page", json(0));
      send_page(id, request, page.is_number() ? page.get<int64_t>() : 0);
    } else if (type == "update-metadata" || type == "update-cell" || type == "remove-dataset" ||
               type == "add-column" || type == "add-peak-column" || type == "update-peak-cell" ||
               type == "get-peak-record") {
      try {
        edit(type, id, request);
      } catch (const std::exception& error) {
        emit({{"type", "edit-error"}, {"dataset_id", id}, {"message", error.what()}});
      }
    } else if (type == "add-dataset") {
      add_dataset(request);
    } else if (type == "reload") {
      Entry& source = entry(id);
      source.dataset = load_dataset(source.path, source.file_type);
      emit({{"type", "dataset-reloaded"}, {"dataset_id", id}});
      send_page(id, request, 0);
    } else if (type == "similarity-options") {
      json datasets = json::array();
      for (const auto& key : order_) {
        const Entry& item = entries_.at(key);
        datasets.push_back({{"id", key}, {"name", item.name}, {"columns", item.dataset.columns()}});
      }
      emit({{"type", "similarity-options"}, {"datasets", datasets}, {"active_dataset_id", id}});
    } else if (type == "calculate-similarity") {
      try {
        calculate_similarity(request);
      } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        emit({{"type", "similarity-error"}, {"message", error.what()}});
      }
    } else if (type == "assign-spec-id") {
      try {
        Entry& source = entry(id);
        json prefix = request.value("prefix", json(""));
        json overwrite = request.value("overwrite", json(false));
        if (!prefix.is_string() || !overwrite.is_boolean()) {
          throw std::invalid_argument("prefix must be a string and overwrite must be a boolean");
        }
        if (!msentity::processing::set_spec_id(source.dataset, "SpecID", prefix.get<std::string>(),
                                               overwrite.get<bool>())) {
          throw std::invalid_argument("SpecID already exists. Allow replacement to assign new IDs.");
        }
        emit({{"type", "spec-id-complete"}, {"dataset_id", id}, {"total_rows", source.dataset.size()}});
      } catch (const std::exception& error) {
        emit({{"type", "spec-id-error"}, {"dataset_id", id}, {"message", error.what()}});
      }
    } else if (type == "column-values") {
      column_values(id, request);
    } else if (type == "render-structure") {
      // The host answers chemistry requests; this is reached only without it.
      emit({{"type", "chemistry-error"}, {"operation", "render-structure"},
            {"message", "Structure rendering requires optional RDKit support"}});
    } else if (type == "calculate-structure-counts") {
      emit({{"type", "structure-counts-error"}, {"dataset_id", id},
            {"message", "Structure counting requires optional RDKit support"}});
    } else if (type == "export") {
      export_dataset(id, request);
    } else {
      emit({{"type", "error"}, {"title", "Unknown request"}, {"message", type}});
    }
  }

  void edit(const std::string& type, const std::string& id, const json& request) {
    Entry& source = entry(id);
    MSDataset& current = source.dataset;
    if (type == "remove-dataset") {
      entries_.erase(id);
      order_.erase(std::find(order_.begin(), order_.end(), id));
      emit({{"type", "dataset-removed"}, {"dataset_id", id}});
      return;
    }
    if (type == "add-column" || type == "add-peak-column") {
      json column_json = request.value("column", json());
      json initial = request.value("value", json(""));
      std::string column = column_json.is_string() ? column_json.get<std::string>() : "";
      auto begin = column.find_first_not_of(" \t\r\n");
      if (begin == std::string::npos) throw std::invalid_argument("Column name must not be empty");
      column = column.substr(begin, column.find_last_not_of(" \t\r\n") - begin + 1);
      if (!initial.is_string()) throw std::invalid_argument("Initial value must be text");
      bool peak_column = type == "add-peak-column";
      const auto& existing = peak_column ? current.peaks().metadata_columns() : current.columns();
      std::string folded = fold_case(column);
      bool reserved = peak_column ? (folded == "mz" || folded == "m/z" || folded == "intensity")
                                  : folded == "peak";
      if (reserved || std::find(existing.begin(), existing.end(), column) != existing.end()) {
        throw std::invalid_argument("Column name already exists or is reserved");
      }
      if (peak_column) {
        current.peaks().set_metadata_column(column, Value(initial.get<std::string>()));
      } else {
        current.set_column(column, Value(initial.get<std::string>()));
      }
      emit({{"type", peak_column ? "peak-columns-updated" : "column-added"},
            {"dataset_id", id}, {"column", column}});
      return;
    }
    if (type == "update-peak-cell" || type == "get-peak-record") {
      int64_t position = position_of(current, request.value("row_id", json()));
      json row_id = request["row_id"];
      if (type == "update-peak-cell") {
        std::string column = json_text(request.value("column", json()));
        const auto& columns = current.peaks().metadata_columns();
        if (std::find(columns.begin(), columns.end(), column) == columns.end()) {
          throw std::invalid_argument("Unknown peak annotation column");
        }
        auto spectrum = current.peaks().spectrum(position);
        json peak = request.value("peak_index", json());
        if (!peak.is_number_integer() || peak.get<int64_t>() < 0 ||
            peak.get<int64_t>() >= spectrum.size()) {
          throw std::invalid_argument("Unknown peak");
        }
        json text = request.value("value", json());
        if (!text.is_string()) throw std::invalid_argument("Annotation must be text");
        auto table = spectrum.metadata();
        std::vector<Value> values = array_values(*table->GetColumnByName(column));
        auto& cell = values[static_cast<std::size_t>(peak.get<int64_t>())];
        cell = edited_value(cell, text.get<std::string>(), true);
        // A one-spectrum view shares the peak storage, so this edits the dataset.
        current.peaks().select({position}).set_metadata_column(column, values);
      }
      emit({{"type", "peak-record"}, {"dataset_id", id}, {"row_id", row_id},
            {"modified", type == "update-peak-cell"},
            {"spectrum", spectrum_json(current.peaks().spectrum(position))}});
      return;
    }
    json response = {{"type", "metadata-updated"}, {"dataset_id", id}};
    if (type == "update-metadata") {
      json description = request.value("description", json());
      json attributes = request.value("attributes", json());
      json tags = request.value("tags", json());
      if (!description.is_string()) throw std::invalid_argument("Description must be text");
      if (!attributes.is_object()) throw std::invalid_argument("Attribute names and values must be text");
      msentity::Attributes pairs;
      for (const auto& [key, value] : attributes.items()) {
        if (!value.is_string()) throw std::invalid_argument("Attribute names and values must be text");
        pairs.emplace_back(key, value.get<std::string>());
      }
      if (!tags.is_array()) throw std::invalid_argument("Tags must be a list of text values");
      std::vector<std::string> tag_list;
      for (const auto& tag : tags) {
        if (!tag.is_string()) throw std::invalid_argument("Tags must be a list of text values");
        tag_list.push_back(tag.get<std::string>());
      }
      current.set_description(description.get<std::string>());
      current.set_attributes(pairs);
      current.set_tags(tag_list);
      response["metadata"] = {{"description", current.description()},
                              {"attributes", attributes_json(current)},
                              {"tags", current.tags()}};
    } else {  // update-cell
      std::string column = json_text(request.value("column", json()));
      if (!current.has_column(column)) throw std::invalid_argument("Unknown metadata column");
      int64_t position = position_of(current, request.value("row_id", json()));
      Value old_value = current.value(position, column);
      current.set_value(position, column,
                        edited_value(old_value, json_text(request.value("value", json(""))), false));
    }
    emit(response);
  }

  void add_dataset(const json& request) {
    fs::path path = resolve(json_text(request.value("path", json(""))));
    if (!fs::is_regular_file(path)) throw std::runtime_error("No such file: " + utf8(path));
    std::optional<std::string> file_type;
    if (request.contains("file_type") && request["file_type"].is_string()) {
      file_type = request["file_type"].get<std::string>();
    }
    // Each addition reads the source again and owns independent edits.
    MSDataset dataset = load_dataset(path, file_type);
    std::string id = utf8(path);
    if (used_ids_.count(id)) {
      std::random_device random;
      char suffix[33];
      std::snprintf(suffix, sizeof(suffix), "%08x%08x%08x%08x", random(), random(), random(), random());
      id += "#" + std::string(suffix);
    }
    std::set<std::string> names;
    for (const auto& [key, item] : entries_) names.insert(item.name);
    std::string name = utf8(path.filename());
    for (int n = 1; names.count(name); ++n) {
      name = utf8(path.stem()) + " (" + std::to_string(n) + ")" + utf8(path.extension());
    }
    add_entry(id, Entry{dataset, path, file_type, name});
    emit({{"type", "dataset-added"},
          {"dataset", {{"id", id}, {"name", name}, {"path", utf8(path)}, {"total_rows", dataset.size()}}}});
    emit({{"type", "dataset-page"}, {"value", page_json(dataset, 0, id, entries_.at(id))}});
  }

  void calculate_similarity(const json& request) {
    namespace sim = msentity::similarity;
    std::string mode = json_text(request.value("mode", json("by_key")));
    std::string id1 = json_text(request.value("dataset1", json()));
    if (!entries_.count(id1)) throw std::invalid_argument("Select a loaded query dataset");
    const Entry& first = entries_.at(id1);
    Entry loaded;
    const Entry* second = nullptr;
    std::string reference_path = json_text(request.value("reference_path", json()));
    if (!reference_path.empty()) {
      fs::path path = resolve(reference_path);
      if (!fs::is_regular_file(path)) throw std::runtime_error("No such file: " + utf8(path));
      loaded = Entry{load_dataset(path, std::nullopt), path, std::nullopt, utf8(path.filename())};
      second = &loaded;
    } else {
      std::string id2 = json_text(request.value("dataset2", json()));
      if (!entries_.count(id2)) {
        throw std::invalid_argument("Select a loaded reference dataset or a reference file");
      }
      second = &entries_.at(id2);
    }
    fs::path target = resolve(json_text(request.value("path", json(""))));
    for (const auto& [key, item] : entries_) {
      if (item.path == target) throw std::invalid_argument("Output must not overwrite an input dataset");
    }
    if (second->path == target) throw std::invalid_argument("Output must not overwrite an input dataset");

    json parameters = request.value("parameters", json::object());
    if (!parameters.is_object()) throw std::invalid_argument("Similarity parameters must be an object");
    sim::Options options;
    double threshold = 0.8;
    std::optional<bool> include;
    std::string key1 = "SpecID";
    std::string key2 = "SpecID";
    for (const auto& [name, value] : parameters.items()) {
      if (name == "method") {
        options.method = sim::parse_method(json_text(value));
      } else if (name == "threshold") {
        threshold = value.get<double>();
      } else if (name == "bin_width") {
        options.bin_width = value.get<double>();
      } else if (name == "intensity_exponent") {
        options.intensity_exponent = value.get<double>();
      } else if (name == "threads") {
        options.threads = value.get<int>();
      } else if (name == "include_matched_data") {
        include = value.get<bool>();
      } else if (name == "key1") {
        key1 = json_text(value);
      } else if (name == "key2") {
        key2 = json_text(value);
      } else {
        throw std::invalid_argument("Unknown similarity parameter: " + name);
      }
    }

    sim::SimilarityDataset result = [&]() {
      if (mode == "library_search") {
        Throttle throttle;
        auto progress = [&throttle](int64_t done, int64_t total) {
          double percent = total ? done * 100.0 / total : 100.0;
          if (!throttle.due(percent, done >= total)) return;
          emit({{"type", "similarity-progress"}, {"processed", done}, {"total", total},
                {"percent", percent}});
        };
        return sim::calculate_library_search(first.dataset, second->dataset, threshold, options,
                                             include.value_or(true), utf8(first.path),
                                             utf8(second->path), progress);
      }
      if (mode == "by_key") {
        if (first.path == second->path) {
          throw std::invalid_argument("Select two different datasets for metadata-key matching");
        }
        return sim::calculate_similarity(first.dataset, second->dataset, key1, key2, options,
                                         include.value_or(false), utf8(first.path),
                                         utf8(second->path));
      }
      throw std::invalid_argument("Unknown similarity mode: " + mode);
    }();
    result.save(utf8(target));
    auto metadata = json::parse(result.metadata_json());
    emit({{"type", "similarity-complete"}, {"path", utf8(target)}, {"total_rows", result.size()},
          {"candidate_pairs", metadata.value("candidate_pair_count", json(nullptr))}});
  }

  // Values of one column for the host (SMARTS filters, structure counts):
  // {"type": "column-values", "request_id", "dataset_id", "column", "values", "row_ids", "total_rows"}
  void column_values(const std::string& id, const json& request) {
    json reply = {{"type", "column-values"}, {"request_id", request.value("request_id", json())},
                  {"dataset_id", id}};
    try {
      const Entry& source = entry(id);
      MSDataset view = apply_dataset_view(source.dataset, request.value("filters", json()), json());
      std::string column = json_text(request.value("column", json()));
      if (request.value("detect_smiles", false)) {
        auto smiles = detect_smiles_column(view.columns(), structure_column_);
        if (!smiles) throw std::invalid_argument("No SMILES column was found in this dataset");
        column = *smiles;
      }
      if (!view.has_column(column)) throw msentity::KeyError("Unknown column: " + column);
      json values = json::array();
      for (const auto& value : view.column_values(column)) values.push_back(to_json(value));
      reply["column"] = column;
      reply["values"] = values;
      reply["row_ids"] = view.peaks().index();
      reply["total_rows"] = view.size();
    } catch (const std::exception& error) {
      reply["error"] = error.what();
    }
    emit(reply);
  }

  void export_dataset(const std::string& id, const json& request) {
    Entry& source = entry(id);
    fs::path output = resolve(json_text(request.value("path", json(""))));
    emit({{"type", "export-start"}, {"path", utf8(output)}});
    try {
      MSDataset view = apply_dataset_view(source.dataset, request.value("filters", json()),
                                          request.value("sort", json()),
                                          request.value("columns", json()));
      std::string type = request.contains("file_type") && request["file_type"].is_string()
                             ? fold_case(request["file_type"].get<std::string>())
                             : lower_extension(output);
      if (type != "msds" && type != "msp" && type != "mgf" && type != "tsv" && type != "csv") {
        throw std::invalid_argument("Output format must be msds, msp, mgf, tsv, or csv");
      }
      if (output.has_parent_path()) fs::create_directories(output.parent_path());
      Throttle throttle;
      auto progress = [&throttle](int64_t processed, int64_t total) {
        double percent = total == 0 ? 100.0 : processed * 100.0 / total;
        if (!throttle.due(percent, processed == total)) return;
        emit({{"type", "export-progress"}, {"processed", processed}, {"total", total},
              {"percent", percent}});
      };
      int64_t total = view.size();
      progress(0, total);
      std::string path = utf8(output);
      if (type == "msds") {
        msentity::io::write_msds(view, path);
      } else if (type == "msp" || type == "mgf") {
        msentity::io::TextWriteOptions options;
        options.progress_callback = progress;
        if (type == "msp") {
          msentity::io::write_msp(view, path, options);
        } else {
          msentity::io::write_mgf(view, path, options);
        }
      } else {
        msentity::io::DelimitedWriteOptions options;
        options.progress_callback = progress;
        if (type == "tsv") {
          msentity::io::write_tsv(view, path, options);
        } else {
          msentity::io::write_csv(view, path, options);
        }
      }
      progress(total, total);
      emit({{"type", "export-complete"}, {"path", path}, {"total_rows", total}});
    } catch (const std::exception& error) {
      std::cerr << error.what() << std::endl;
      emit({{"type", "export-error"}, {"message", error.what()}});
    }
  }
};

}  // namespace

int run_dataset_backend(const std::string& path, int page_size,
                        const std::optional<std::string>& file_type) {
  DatasetBackend backend(std::min(500, std::max(1, page_size)));
  return backend.run(resolve(path), file_type);
}

}  // namespace viewer
