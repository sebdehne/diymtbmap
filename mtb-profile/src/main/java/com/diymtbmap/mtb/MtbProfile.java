package com.diymtbmap.mtb;

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.reader.SourceFeature;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Tileset profile that emits every OSM way tagged as a mountain-bike trail into
 * layer {@code mtb}, as a line feature at z{minZoom}..14, so the dedicated
 * {@code mtb.mbtiles} overlay is the single source of MTB trails at low zooms
 * while the basemap tileset stays 100% stock (no mtb_* at all).
 *
 * <p>Two kinds of trail are distinguished by the {@code mtb_kind} attribute,
 * which is the single switch the UI uses to pick an overlay + color ramp and to
 * let the user toggle each kind on/off independently:
 *
 * <ul>
 *   <li>{@code mtb_kind = "bikepark"} — the way carries {@code mtb:scale:imba}
 *       (IMBA 0-4, the constructed bike-park rating). Emits {@code mtb_imba}.
 *   <li>{@code mtb_kind = "natural"} — the way carries {@code mtb:scale} (0-6
 *       with {@code +}/{@code -} variants) and no IMBA rating. Emits
 *       {@code mtb_scale}.
 * </ul>
 *
 * <p>A way is emitted when it carries a non-empty {@code mtb:scale} OR
 * {@code mtb:scale:imba} (bike parks may carry only the IMBA rating). Optional
 * popover attributes ({@code mtb_name}, {@code class_bicycle_mtb},
 * {@code trail_visibility}, {@code bicycle}, {@code aerialway_bicycle}) are
 * emitted only when the underlying OSM tag is present and non-empty.
 *
 * <p>The {@code mtb_profile_version} metadata (see
 * {@link #PROFILE_VERSION}) records the schema of the emitted attributes so the
 * orchestrator can tell a tileset built by an older, narrower profile apart from
 * the current one (a stale artifact degrades gracefully to natural trails, and
 * the app warns that FORCE_REIMPORT=1 is needed for the full overlay).
 *
 * <p>Stateless: the build-time {@code --minzoom} (from the MTB_MINZOOM build
 * parameter) is captured at construction; nothing else is persisted and there is
 * no database.
 */
public class MtbProfile implements Profile {

  /** MBTiles layer name (and Martin source id) for the overlay tileset. */
  public static final String LAYER = "mtb";

  // OSM tags that select a way (a way is emitted if either is non-empty).
  /** Natural-trail difficulty (0-6, optional + / - variant). */
  public static final String OSM_TAG_SCALE = "mtb:scale";
  /** Bike-park (IMBA) rating, 0-4 — constructed trails. */
  public static final String OSM_TAG_IMBA = "mtb:scale:imba";

  // Feature attributes (MVT fields).
  /** Raw {@code mtb:scale} value (e.g. "3", "4+"); present on natural trails. */
  public static final String ATTR_SCALE = "mtb_scale";
  /** Raw {@code mtb:scale:imba} value (0-4); present on bike-park trails. */
  public static final String ATTR_IMBA = "mtb_imba";
  /** "natural" or "bikepark" — the overlay/toggle discriminator. */
  public static final String ATTR_KIND = "mtb_kind";
  /** Trail-specific name ({@code mtb:name}); popover label. */
  public static final String ATTR_NAME = "mtb_name";
  /** Subjective MTB suitability ({@code class:bicycle:mtb}). */
  public static final String ATTR_CLASS_BICYCLE_MTB = "class_bicycle_mtb";
  /** How visible the trail is ({@code trail_visibility}). */
  public static final String ATTR_TRAIL_VISIBILITY = "trail_visibility";
  /** Bicycle access ({@code bicycle}). */
  public static final String ATTR_BICYCLE = "bicycle";
  /** Whether a bicycle can ride the lift ({@code aerialway:bicycle}). */
  public static final String ATTR_AERIALWAY_BICYCLE = "aerialway_bicycle";

  /** {@code mtb_kind} value for a {@code mtb:scale} trail. */
  public static final String KIND_NATURAL = "natural";
  /** {@code mtb_kind} value for an {@code mtb:scale:imba} (bike-park) trail. */
  public static final String KIND_BIKEPARK = "bikepark";

  /** MBTiles metadata key recording the emitted-attribute schema version. */
  public static final String META_PROFILE_VERSION = "mtb_profile_version";
  /**
   * Current attribute-schema version. Bump whenever the set of emitted
   * attributes changes so the orchestrator can detect a stale artifact. Keep
   * in sync with {@code MTB_PROFILE_VERSION} in {@code src/verify.ts}.
   */
  public static final String PROFILE_VERSION = "2";

  /** Hard upper zoom of the overlay tileset (matches the basemap maxzoom). */
  public static final int MAXZOOM = 14;

  private final int minZoom;

  public MtbProfile(int minZoom) {
    this.minZoom = minZoom;
  }

  @Override
  public void processFeature(SourceFeature feature, FeatureCollector features) {
    if (!feature.canBeLine()) {
      return;
    }
    String scale = feature.getString(OSM_TAG_SCALE);
    String imba = feature.getString(OSM_TAG_IMBA);
    boolean hasScale = scale != null && !scale.isEmpty();
    boolean hasImba = imba != null && !imba.isEmpty();
    if (!hasScale && !hasImba) {
      return;
    }
    boolean bikePark = hasImba;

    FeatureCollector.Feature line = features.line(LAYER).setZoomRange(minZoom, MAXZOOM);
    // The kind is always present (it drives the UI's overlay + toggle split).
    line.setAttr(ATTR_KIND, bikePark ? KIND_BIKEPARK : KIND_NATURAL);
    if (hasScale) {
      line.setAttr(ATTR_SCALE, scale);
    }
    if (hasImba) {
      line.setAttr(ATTR_IMBA, imba);
    }
    // Optional popover attributes — emitted only when the tag is present so a
    // tileset with none of them stays byte-compatible with the v1 schema.
    setIfPresent(line, feature, "mtb:name", ATTR_NAME);
    setIfPresent(line, feature, "class:bicycle:mtb", ATTR_CLASS_BICYCLE_MTB);
    setIfPresent(line, feature, "trail_visibility", ATTR_TRAIL_VISIBILITY);
    setIfPresent(line, feature, "bicycle", ATTR_BICYCLE);
    setIfPresent(line, feature, "aerialway:bicycle", ATTR_AERIALWAY_BICYCLE);
  }

  private static void setIfPresent(
    FeatureCollector.Feature line, SourceFeature feature, String osmTag, String attr) {
    String value = feature.getString(osmTag);
    if (value != null && !value.isEmpty()) {
      line.setAttr(attr, value);
    }
  }

  @Override
  public String name() {
    return "MTB trails (mtb:scale + mtb:scale:imba)";
  }

  @Override
  public String description() {
    return "Every OSM way tagged as an MTB trail (natural mtb:scale or bike-park mtb:scale:imba), "
      + "as a dedicated low-zoom MTB overlay tileset with a mtb_kind discriminator.";
  }

  @Override
  public String attribution() {
    return OSM_ATTRIBUTION;
  }

  @Override
  public String version() {
    return PROFILE_VERSION;
  }

  @Override
  public boolean isOverlay() {
    return true;
  }

  @Override
  public Map<String, String> extraArchiveMetadata() {
    Map<String, String> meta = new LinkedHashMap<>();
    meta.put("mtb_minzoom", Integer.toString(minZoom));
    meta.put(META_PROFILE_VERSION, PROFILE_VERSION);
    meta.put(
      "mtb_tags",
      OSM_TAG_SCALE + "," + OSM_TAG_IMBA
        + ",mtb:name,class:bicycle:mtb,trail_visibility,bicycle,aerialway:bicycle");
    return meta;
  }
}
