/** A glass camera body with a simple coated optical lens. */
export function OpticalLens() {
  return <div className="optical-stage" aria-hidden="true">
    <div className="glass-camera">
      <div className="camera-shutter" />
      <div className="camera-top" />
      <div className="camera-body" />
      <div className="camera-viewfinder" />
      <div className="camera-flash" />
      <div className="camera-grip" />
      <div className="optical-lens">
        <div className="lens-glass"><div className="lens-pupil" /></div>
        <div className="lens-reflection" />
      </div>
    </div>
  </div>;
}
